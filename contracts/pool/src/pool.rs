//! Benzo pool contract implementation.

use contract_types::Groth16Proof;
use soroban_sdk::{
    Address, Bytes, BytesN, Env, Symbol, U256, Vec, contract, contractclient, contracterror,
    contractevent, contractimpl, contracttype, crypto::bn254::Bn254Fr, symbol_short,
    token::TokenClient, xdr::ToXdr,
};
use soroban_utils::constants::bn256_modulus;

/// vk_id under which the SHIELD circuit's verification key is registered.
pub const VK_SHIELD: Symbol = symbol_short!("SHIELD");
/// vk_id for the TRANSFER (2-in/2-out join-split) circuit.
pub const VK_TRANSFER: Symbol = symbol_short!("TRANSFER");
/// vk_id for the UNSHIELD (withdraw + proof-of-innocence) circuit.
pub const VK_UNSHIELD: Symbol = symbol_short!("UNSHIELD");
/// vk_id for the ORG join-split (in-circuit M-of-N dual-control) circuit. An org
/// note (recipientPk = orgRecipientPk) can ONLY be spent through `transfer_org`,
/// whose proof (JSPLITORG) enforces >= threshold member signatures in-circuit —
/// so org funds cannot move on a single key. Same 11 public inputs as TRANSFER.
pub const VK_JSPLITORG: Symbol = symbol_short!("JSPLITORG");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this operation
    NotAuthorized = 1,
    /// Contract is not initialized
    NotInitialized = 2,
    /// Amount is invalid (zero, negative, or exceeds the deposit cap)
    WrongAmount = 3,
    /// Zero-knowledge proof verification failed
    InvalidProof = 4,
    /// Provided Merkle root is not in the recent history
    UnknownRoot = 5,
    /// One nullifier of the set is already spent and another is not
    /// (a full replay is an idempotent no-op; a partial replay is an attack)
    PartialReplay = 6,
    /// External data hash does not match the provided data
    WrongExtHash = 7,
    /// ASP root does not match the registry's current root
    WrongAspRoot = 8,
    /// Public input is not canonical in the BN254 scalar field
    NonCanonicalPublicInput = 9,
    /// Contract is paused
    Paused = 10,
    /// Arithmetic overflow occurred
    Overflow = 11,
    /// Withdrawal would exceed the net shielded supply (turnstile backstop).
    InsufficientPoolSupply = 12,
    /// registered_mvk_root is not a known root of the authorized-MVK registry
    WrongMvkRoot = 13,
    /// A batch settlement was submitted with no items
    EmptyBatch = 14,
    /// Two items in one batch reuse the same input nullifier (intra-batch
    /// double-spend) — rejected before any state is applied
    DuplicateInBatch = 15,
}

/// One org join-split inside a batched payroll run. Carries exactly the per-spend
/// fields of `transfer_org` (minus the shared `submitter`). A `Vec<OrgSpend>` is
/// settled by `batch_transfer_org` with ONE combined verification.
#[contracttype]
#[derive(Clone)]
pub struct OrgSpend {
    pub root: U256,
    pub nullifier0: U256,
    pub nullifier1: U256,
    pub out_commitment0: U256,
    pub out_commitment1: U256,
    pub fee: i128,
    pub relayer: Address,
    pub mvk_tag0: U256,
    pub mvk_tag1: U256,
    pub note_ct0: Bytes,
    pub note_ct1: Bytes,
    pub mvk_ct0: Bytes,
    pub mvk_ct1: Bytes,
    pub registered_mvk_root: U256,
    pub proof: Groth16Proof,
}

/// Storage keys for pool persistent state.
#[contracttype]
#[derive(Clone, Debug)]
pub(crate) enum DataKey {
    Admin,
    Token,
    /// Domain tag for the custodied asset: keccak256(token address XDR) mod p
    AssetId,
    Verifier,
    MerkleTree,
    NullifierSet,
    AspMembership,
    AspNonMembership,
    ViewkeyAnchor,
    MaximumDepositAmount,
    IsPaused,
    /// Net shielded supply (Σ deposits − Σ withdrawals) — the turnstile backstop.
    TotalShielded,
    /// Authorized-MVK registry (a merkle instance); when set, shield/transfer/
    /// withdraw require registered_mvk_root to be one of its known roots.
    MvkRegistry,
}

// ---- cross-contract clients ----

#[contractclient(crate_path = "soroban_sdk", name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(
        env: Env,
        vk_id: Symbol,
        proof: Groth16Proof,
        public_inputs: Vec<Bn254Fr>,
    ) -> Result<bool, soroban_sdk::Error>;
    fn verify_batch(
        env: Env,
        vk_id: Symbol,
        proofs: Vec<Groth16Proof>,
        pub_inputs: Vec<Vec<Bn254Fr>>,
    ) -> Result<bool, soroban_sdk::Error>;
}

#[contractclient(crate_path = "soroban_sdk", name = "MerkleClient")]
pub trait MerkleInterface {
    fn insert_leaf(env: Env, leaf: U256) -> Result<u32, soroban_sdk::Error>;
    fn insert_leaves(env: Env, leaves: Vec<U256>) -> Result<Vec<u32>, soroban_sdk::Error>;
    fn is_known_root(env: Env, root: U256) -> Result<bool, soroban_sdk::Error>;
    fn current_root(env: Env) -> Result<U256, soroban_sdk::Error>;
}

#[contractclient(crate_path = "soroban_sdk", name = "NullifierSetClient")]
pub trait NullifierSetInterface {
    fn is_spent(env: Env, nullifier: U256) -> bool;
    fn spend(env: Env, nullifier: U256) -> Result<bool, soroban_sdk::Error>;
}

#[contractclient(crate_path = "soroban_sdk", name = "AspMembershipClient")]
pub trait AspMembershipInterface {
    fn get_root(env: Env) -> Result<U256, soroban_sdk::Error>;
}

#[contractclient(crate_path = "soroban_sdk", name = "AspNonMembershipClient")]
pub trait AspNonMembershipInterface {
    fn get_root(env: Env) -> Result<U256, soroban_sdk::Error>;
}

#[contractclient(crate_path = "soroban_sdk", name = "ViewkeyAnchorClient")]
pub trait ViewkeyAnchorInterface {
    fn bind_mvk(env: Env, tag: U256, mvk_ct: Bytes) -> Result<(), soroban_sdk::Error>;
}

// ---- events ----

/// Emitted for every new note (shield output, transfer outputs, change note).
#[contractevent]
#[derive(Clone)]
pub struct NewCommitmentEvent {
    /// The note commitment inserted into the tree
    #[topic]
    pub commitment: U256,
    /// Leaf index in the Merkle tree
    pub index: u32,
    /// X25519+AES-GCM note ciphertext for recipient discovery
    pub encrypted_output: Bytes,
    /// The note's MVK tag (compliance binding)
    pub mvk_tag: U256,
}

/// Emitted when an input note is spent.
#[contractevent]
#[derive(Clone)]
pub struct NewNullifierEvent {
    /// The spent nullifier
    #[topic]
    pub nullifier: U256,
}

/// Emitted on shield (public deposit edge).
#[contractevent]
#[derive(Clone)]
pub struct ShieldEvent {
    /// Depositor address (public by nature of the deposit edge)
    #[topic]
    pub from: Address,
    /// Public deposit amount
    pub amount: i128,
    /// The output commitment
    pub commitment: U256,
}

/// Emitted on withdraw (public exit edge).
#[contractevent]
#[derive(Clone)]
pub struct WithdrawEvent {
    /// Withdrawal recipient (public by nature of the exit edge)
    #[topic]
    pub to: Address,
    /// Public withdrawal amount
    pub amount: i128,
    /// The spent nullifier
    pub nullifier: U256,
}

/// Emitted when the admin re-points the pool at a new verifier (audit trail for
/// a governance action that hot-swaps verification logic on the money path).
#[contractevent]
#[derive(Clone)]
pub struct VerifierRotatedEvent {
    /// The new verifier contract address
    #[topic]
    pub new_verifier: Address,
}

#[contract]
pub struct BenzoPool;

#[contractimpl]
impl BenzoPool {
    /// Initialize the pool with its module addresses and custody token.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        verifier: Address,
        merkle: Address,
        nullifier_set: Address,
        asp_membership: Address,
        asp_non_membership: Address,
        viewkey_anchor: Address,
        maximum_deposit_amount: i128,
    ) {
        let storage = env.storage().persistent();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Token, &token);
        storage.set(&DataKey::Verifier, &verifier);
        storage.set(&DataKey::MerkleTree, &merkle);
        storage.set(&DataKey::NullifierSet, &nullifier_set);
        storage.set(&DataKey::AspMembership, &asp_membership);
        storage.set(&DataKey::AspNonMembership, &asp_non_membership);
        storage.set(&DataKey::ViewkeyAnchor, &viewkey_anchor);
        storage.set(&DataKey::MaximumDepositAmount, &maximum_deposit_amount);
        storage.set(&DataKey::IsPaused, &false);

        // Pin the asset domain tag once: keccak256(token XDR) reduced mod p.
        let asset_id = Self::address_to_scalar(&env, &token);
        storage.set(&DataKey::AssetId, &asset_id);
    }

    // =========================================================== shield ====

    /// Shield: deposit public tokens into a fresh shielded note.
    ///
    /// Public inputs (must match the SHIELD circuit declaration order):
    /// `[commitment, amount, asset_id, depositor, asp_membership_root, mvk_tag]`
    #[allow(clippy::too_many_arguments)]
    pub fn shield(
        env: Env,
        from: Address,
        amount: i128,
        commitment: U256,
        mvk_tag: U256,
        note_ct: Bytes,
        mvk_ct: Bytes,
        asp_membership_root: U256,
        registered_mvk_root: U256,
        proof: Groth16Proof,
    ) -> Result<u32, Error> {
        from.require_auth();
        Self::require_not_paused(&env)?;

        let max: i128 = Self::get(&env, &DataKey::MaximumDepositAmount)?;
        if amount <= 0 || amount > max {
            return Err(Error::WrongAmount);
        }

        // ASP allow-membership: the proof must target the registry's root.
        let asp_addr: Address = Self::get(&env, &DataKey::AspMembership)?;
        let current_allow_root = AspMembershipClient::new(&env, &asp_addr).get_root();
        if asp_membership_root != current_allow_root {
            return Err(Error::WrongAspRoot);
        }

        let modulus = bn256_modulus(&env);
        let depositor = Self::address_to_scalar(&env, &from);
        let asset_id: U256 = Self::get(&env, &DataKey::AssetId)?;

        let mut public_inputs: Vec<Bn254Fr> = Vec::new(&env);
        Self::push_input(&env, &mut public_inputs, &commitment, &modulus)?;
        Self::push_input(
            &env,
            &mut public_inputs,
            &Self::i128_to_u256(&env, amount)?,
            &modulus,
        )?;
        Self::push_input(&env, &mut public_inputs, &asset_id, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &depositor, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &asp_membership_root, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &mvk_tag, &modulus)?;
        Self::check_mvk_root(&env, &registered_mvk_root)?;
        Self::push_input(&env, &mut public_inputs, &registered_mvk_root, &modulus)?;

        Self::verify(&env, VK_SHIELD, &proof, &public_inputs)?;

        // Pull the public deposit into custody.
        let token: Address = Self::get(&env, &DataKey::Token)?;
        TokenClient::new(&env, &token).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );

        // Turnstile: track net shielded supply so withdrawals can never exceed
        // deposits — bounds the blast radius of any undiscovered circuit-soundness
        // bug to actually-deposited funds (the Zcash turnstile invariant).
        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalShielded)
            .unwrap_or(0);
        let total = total.checked_add(amount).ok_or(Error::Overflow)?;
        env.storage().persistent().set(&DataKey::TotalShielded, &total);
        soroban_utils::bump_persistent(&env, &DataKey::TotalShielded);

        // Insert the note and record the compliance binding.
        let merkle: Address = Self::get(&env, &DataKey::MerkleTree)?;
        let index = MerkleClient::new(&env, &merkle).insert_leaf(&commitment);

        let viewkey: Address = Self::get(&env, &DataKey::ViewkeyAnchor)?;
        ViewkeyAnchorClient::new(&env, &viewkey).bind_mvk(&mvk_tag, &mvk_ct);

        ShieldEvent {
            from,
            amount,
            commitment: commitment.clone(),
        }
        .publish(&env);
        NewCommitmentEvent {
            commitment,
            index,
            encrypted_output: note_ct,
            mvk_tag,
        }
        .publish(&env);

        Ok(index)
    }

    // ========================================================= transfer ====

    /// Private transfer: 2-in/2-out join-split. No token movement except an
    /// optional public `fee` paid from the pool to the relayer.
    ///
    /// Public inputs (must match the TRANSFER circuit declaration order):
    /// `[root, asset_id, nullifier0, nullifier1, out_commitment0,
    ///   out_commitment1, fee, ext_data_hash, mvk_tag0, mvk_tag1]`
    #[allow(clippy::too_many_arguments)]
    pub fn transfer(
        env: Env,
        submitter: Address,
        root: U256,
        nullifier0: U256,
        nullifier1: U256,
        out_commitment0: U256,
        out_commitment1: U256,
        fee: i128,
        relayer: Address,
        mvk_tag0: U256,
        mvk_tag1: U256,
        note_ct0: Bytes,
        note_ct1: Bytes,
        mvk_ct0: Bytes,
        mvk_ct1: Bytes,
        registered_mvk_root: U256,
        proof: Groth16Proof,
    ) -> Result<(), Error> {
        submitter.require_auth();
        Self::require_not_paused(&env)?;

        if fee < 0 {
            return Err(Error::WrongAmount);
        }

        let merkle_addr: Address = Self::get(&env, &DataKey::MerkleTree)?;
        let merkle = MerkleClient::new(&env, &merkle_addr);
        if !merkle.is_known_root(&root) {
            return Err(Error::UnknownRoot);
        }

        // Idempotent replay rule (Umbra): full replay converges to success
        // with no state change; partial replay is rejected.
        let ns_addr: Address = Self::get(&env, &DataKey::NullifierSet)?;
        let ns = NullifierSetClient::new(&env, &ns_addr);
        let spent0 = ns.is_spent(&nullifier0);
        let spent1 = ns.is_spent(&nullifier1);
        if spent0 && spent1 {
            return Ok(());
        }
        if spent0 || spent1 {
            return Err(Error::PartialReplay);
        }

        // Bind relayer + ciphertexts into the proof via the ext-data hash.
        let ext_hash = Self::hash_transfer_ext(
            &env, &relayer, fee, &note_ct0, &note_ct1, &mvk_ct0, &mvk_ct1,
        );

        let modulus = bn256_modulus(&env);
        let asset_id: U256 = Self::get(&env, &DataKey::AssetId)?;
        let mut public_inputs: Vec<Bn254Fr> = Vec::new(&env);
        Self::push_input(&env, &mut public_inputs, &root, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &asset_id, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &nullifier0, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &nullifier1, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &out_commitment0, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &out_commitment1, &modulus)?;
        Self::push_input(
            &env,
            &mut public_inputs,
            &Self::i128_to_u256(&env, fee)?,
            &modulus,
        )?;
        Self::push_input(&env, &mut public_inputs, &ext_hash, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &mvk_tag0, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &mvk_tag1, &modulus)?;
        Self::check_mvk_root(&env, &registered_mvk_root)?;
        Self::push_input(&env, &mut public_inputs, &registered_mvk_root, &modulus)?;

        Self::verify(&env, VK_TRANSFER, &proof, &public_inputs)?;

        // Spend inputs, insert outputs.
        ns.spend(&nullifier0);
        ns.spend(&nullifier1);
        NewNullifierEvent {
            nullifier: nullifier0,
        }
        .publish(&env);
        NewNullifierEvent {
            nullifier: nullifier1,
        }
        .publish(&env);

        let idx0 = merkle.insert_leaf(&out_commitment0);
        let idx1 = merkle.insert_leaf(&out_commitment1);

        // Relayer compensation out of the shielded total (value conservation
        // is enforced in-circuit: sum(in) == sum(out) + fee).
        if fee > 0 {
            let token: Address = Self::get(&env, &DataKey::Token)?;
            TokenClient::new(&env, &token).transfer(
                &env.current_contract_address(),
                &relayer,
                &fee,
            );
        }

        let viewkey: Address = Self::get(&env, &DataKey::ViewkeyAnchor)?;
        let vk_client = ViewkeyAnchorClient::new(&env, &viewkey);
        vk_client.bind_mvk(&mvk_tag0, &mvk_ct0);
        vk_client.bind_mvk(&mvk_tag1, &mvk_ct1);

        NewCommitmentEvent {
            commitment: out_commitment0,
            index: idx0,
            encrypted_output: note_ct0,
            mvk_tag: mvk_tag0,
        }
        .publish(&env);
        NewCommitmentEvent {
            commitment: out_commitment1,
            index: idx1,
            encrypted_output: note_ct1,
            mvk_tag: mvk_tag1,
        }
        .publish(&env);

        Ok(())
    }

    // ===================================================== transfer_org ====

    /// Org join-split with IN-CIRCUIT M-of-N dual-control. Identical to `transfer`
    /// (same 11 public inputs, same nullifier/root/ext-hash/turnstile bookkeeping)
    /// EXCEPT it verifies the JSPLITORG verification key instead of TRANSFER. The
    /// JSPLITORG circuit forces >= threshold distinct member EdDSA signatures for an
    /// org input, with the org's member-set root + threshold bound into the spent
    /// note's `recipientPk` (org domain 0x09). Consequences enforced ON-CHAIN here:
    ///   • an org note can ONLY settle through this entry (a consumer `transfer`
    ///     proof can't satisfy an org-recipientPk note — cross-domain preimage),
    ///   • and this entry only accepts a proof that carried M-of-N approval.
    /// So org funds cannot move on a single key — dual-control is enforced by the
    /// verifier inside the pool, not by an off-chain checker.
    #[allow(clippy::too_many_arguments)]
    pub fn transfer_org(
        env: Env,
        submitter: Address,
        root: U256,
        nullifier0: U256,
        nullifier1: U256,
        out_commitment0: U256,
        out_commitment1: U256,
        fee: i128,
        relayer: Address,
        mvk_tag0: U256,
        mvk_tag1: U256,
        note_ct0: Bytes,
        note_ct1: Bytes,
        mvk_ct0: Bytes,
        mvk_ct1: Bytes,
        registered_mvk_root: U256,
        proof: Groth16Proof,
    ) -> Result<(), Error> {
        submitter.require_auth();
        Self::require_not_paused(&env)?;

        if fee < 0 {
            return Err(Error::WrongAmount);
        }

        let merkle_addr: Address = Self::get(&env, &DataKey::MerkleTree)?;
        let merkle = MerkleClient::new(&env, &merkle_addr);
        if !merkle.is_known_root(&root) {
            return Err(Error::UnknownRoot);
        }

        // Idempotent replay rule (Umbra): full replay converges to success
        // with no state change; partial replay is rejected.
        let ns_addr: Address = Self::get(&env, &DataKey::NullifierSet)?;
        let ns = NullifierSetClient::new(&env, &ns_addr);
        let spent0 = ns.is_spent(&nullifier0);
        let spent1 = ns.is_spent(&nullifier1);
        if spent0 && spent1 {
            return Ok(());
        }
        if spent0 || spent1 {
            return Err(Error::PartialReplay);
        }

        // Bind relayer + ciphertexts into the proof via the ext-data hash.
        let ext_hash = Self::hash_transfer_ext(
            &env, &relayer, fee, &note_ct0, &note_ct1, &mvk_ct0, &mvk_ct1,
        );

        let modulus = bn256_modulus(&env);
        let asset_id: U256 = Self::get(&env, &DataKey::AssetId)?;
        let mut public_inputs: Vec<Bn254Fr> = Vec::new(&env);
        Self::push_input(&env, &mut public_inputs, &root, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &asset_id, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &nullifier0, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &nullifier1, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &out_commitment0, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &out_commitment1, &modulus)?;
        Self::push_input(
            &env,
            &mut public_inputs,
            &Self::i128_to_u256(&env, fee)?,
            &modulus,
        )?;
        Self::push_input(&env, &mut public_inputs, &ext_hash, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &mvk_tag0, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &mvk_tag1, &modulus)?;
        Self::check_mvk_root(&env, &registered_mvk_root)?;
        Self::push_input(&env, &mut public_inputs, &registered_mvk_root, &modulus)?;

        // The ONLY difference from `transfer`: the org M-of-N verification key.
        Self::verify(&env, VK_JSPLITORG, &proof, &public_inputs)?;

        // Spend inputs, insert outputs.
        ns.spend(&nullifier0);
        ns.spend(&nullifier1);
        NewNullifierEvent {
            nullifier: nullifier0,
        }
        .publish(&env);
        NewNullifierEvent {
            nullifier: nullifier1,
        }
        .publish(&env);

        let idx0 = merkle.insert_leaf(&out_commitment0);
        let idx1 = merkle.insert_leaf(&out_commitment1);

        if fee > 0 {
            let token: Address = Self::get(&env, &DataKey::Token)?;
            TokenClient::new(&env, &token).transfer(
                &env.current_contract_address(),
                &relayer,
                &fee,
            );
        }

        let viewkey: Address = Self::get(&env, &DataKey::ViewkeyAnchor)?;
        let vk_client = ViewkeyAnchorClient::new(&env, &viewkey);
        vk_client.bind_mvk(&mvk_tag0, &mvk_ct0);
        vk_client.bind_mvk(&mvk_tag1, &mvk_ct1);

        NewCommitmentEvent {
            commitment: out_commitment0,
            index: idx0,
            encrypted_output: note_ct0,
            mvk_tag: mvk_tag0,
        }
        .publish(&env);
        NewCommitmentEvent {
            commitment: out_commitment1,
            index: idx1,
            encrypted_output: note_ct1,
            mvk_tag: mvk_tag1,
        }
        .publish(&env);

        Ok(())
    }

    // =================================================== batch_transfer_org ====

    /// Settle a whole org payroll run (N `transfer_org` spends) with ONE combined
    /// proof verification instead of N. Each spend is an independent JSPLITORG
    /// statement; this entry validates all of them, calls the verifier's batched
    /// (random-linear-combination) check ONCE, then applies every spend's state.
    ///
    /// HONESTY: this batches *verification*, not settlement. The combined pairing
    /// check is still LINEAR in N (one `e(A_i,B_i)` term per proof survives), and
    /// the loop below still spends 2N nullifiers and inserts 2N commitments — the
    /// merkle/nullifier writes are NOT collapsed. So this is "one verification per
    /// run", not "N payments folded into one proof", and N per tx is bounded by
    /// the ledger's instruction/write budget. Intra-batch double-spends are
    /// rejected up front (a single proof can't reuse a nullifier; this stops it
    /// ACROSS proofs in the same tx, which no individual circuit can see).
    pub fn batch_transfer_org(
        env: Env,
        submitter: Address,
        spends: Vec<OrgSpend>,
    ) -> Result<(), Error> {
        submitter.require_auth();
        Self::require_not_paused(&env)?;

        let n = spends.len();
        if n == 0 {
            return Err(Error::EmptyBatch);
        }

        let merkle_addr: Address = Self::get(&env, &DataKey::MerkleTree)?;
        let merkle = MerkleClient::new(&env, &merkle_addr);
        let ns_addr: Address = Self::get(&env, &DataKey::NullifierSet)?;
        let ns = NullifierSetClient::new(&env, &ns_addr);
        let modulus = bn256_modulus(&env);
        let asset_id: U256 = Self::get(&env, &DataKey::AssetId)?;

        // ---- Pass 1: validate every spend, build its public inputs, and reject
        // any already-spent OR intra-batch-duplicated nullifier BEFORE touching
        // state. Then verify the whole batch in one call.
        let mut proofs: Vec<Groth16Proof> = Vec::new(&env);
        let mut batch_inputs: Vec<Vec<Bn254Fr>> = Vec::new(&env);
        let mut seen: Vec<U256> = Vec::new(&env);

        for i in 0..n {
            let s = spends.get(i).ok_or(Error::EmptyBatch)?;
            if s.fee < 0 {
                return Err(Error::WrongAmount);
            }
            if s.proof.is_empty() {
                return Err(Error::InvalidProof);
            }
            if !merkle.is_known_root(&s.root) {
                return Err(Error::UnknownRoot);
            }
            // Freshness: neither input may already be spent on-chain. (Unlike the
            // single-spend idempotent-replay rule, a batch fails closed on any
            // already-spent input rather than trying to converge.)
            if ns.is_spent(&s.nullifier0) || ns.is_spent(&s.nullifier1) {
                return Err(Error::PartialReplay);
            }
            // Intra-batch uniqueness: no nullifier may appear twice across the run
            // (and the two inputs of one spend must differ).
            if s.nullifier0 == s.nullifier1
                || Self::vec_contains(&seen, &s.nullifier0)
                || Self::vec_contains(&seen, &s.nullifier1)
            {
                return Err(Error::DuplicateInBatch);
            }
            seen.push_back(s.nullifier0.clone());
            seen.push_back(s.nullifier1.clone());

            let ext_hash = Self::hash_transfer_ext(
                &env, &s.relayer, s.fee, &s.note_ct0, &s.note_ct1, &s.mvk_ct0, &s.mvk_ct1,
            );
            Self::check_mvk_root(&env, &s.registered_mvk_root)?;

            let mut pi: Vec<Bn254Fr> = Vec::new(&env);
            Self::push_input(&env, &mut pi, &s.root, &modulus)?;
            Self::push_input(&env, &mut pi, &asset_id, &modulus)?;
            Self::push_input(&env, &mut pi, &s.nullifier0, &modulus)?;
            Self::push_input(&env, &mut pi, &s.nullifier1, &modulus)?;
            Self::push_input(&env, &mut pi, &s.out_commitment0, &modulus)?;
            Self::push_input(&env, &mut pi, &s.out_commitment1, &modulus)?;
            Self::push_input(&env, &mut pi, &Self::i128_to_u256(&env, s.fee)?, &modulus)?;
            Self::push_input(&env, &mut pi, &ext_hash, &modulus)?;
            Self::push_input(&env, &mut pi, &s.mvk_tag0, &modulus)?;
            Self::push_input(&env, &mut pi, &s.mvk_tag1, &modulus)?;
            Self::push_input(&env, &mut pi, &s.registered_mvk_root, &modulus)?;

            proofs.push_back(s.proof.clone());
            batch_inputs.push_back(pi);
        }

        // ONE combined verification for the entire run (all under JSPLITORG).
        Self::verify_batch(&env, VK_JSPLITORG, &proofs, &batch_inputs)?;

        // ---- Pass 2: every proof is valid — apply each spend's state.
        // Insert ALL 2N output commitments in ONE batched merkle call (frontier
        // read/written once, single root-history churn) so the per-tx ledger
        // footprint is O(depth + N) instead of O(depth * N) — this is what makes
        // a multi-spend run actually fit a transaction.
        let mut commitments: Vec<U256> = Vec::new(&env);
        for i in 0..n {
            let s = spends.get(i).ok_or(Error::EmptyBatch)?;
            commitments.push_back(s.out_commitment0.clone());
            commitments.push_back(s.out_commitment1.clone());
        }
        let merkle_addr2: Address = Self::get(&env, &DataKey::MerkleTree)?;
        let indices = MerkleClient::new(&env, &merkle_addr2).insert_leaves(&commitments);

        let token: Address = Self::get(&env, &DataKey::Token)?;
        let viewkey: Address = Self::get(&env, &DataKey::ViewkeyAnchor)?;
        let vk_client = ViewkeyAnchorClient::new(&env, &viewkey);

        for i in 0..n {
            let s = spends.get(i).ok_or(Error::EmptyBatch)?;
            ns.spend(&s.nullifier0);
            ns.spend(&s.nullifier1);
            NewNullifierEvent { nullifier: s.nullifier0.clone() }.publish(&env);
            NewNullifierEvent { nullifier: s.nullifier1.clone() }.publish(&env);

            // commitments were pushed [c0, c1] per item, so item i's leaves are
            // at flat positions 2i and 2i+1 in the returned index vector.
            let idx0 = indices.get(i.checked_mul(2).ok_or(Error::Overflow)?).ok_or(Error::EmptyBatch)?;
            let idx1 = indices
                .get(i.checked_mul(2).ok_or(Error::Overflow)?.checked_add(1).ok_or(Error::Overflow)?)
                .ok_or(Error::EmptyBatch)?;

            if s.fee > 0 {
                TokenClient::new(&env, &token).transfer(
                    &env.current_contract_address(),
                    &s.relayer,
                    &s.fee,
                );
            }

            vk_client.bind_mvk(&s.mvk_tag0, &s.mvk_ct0);
            vk_client.bind_mvk(&s.mvk_tag1, &s.mvk_ct1);

            NewCommitmentEvent {
                commitment: s.out_commitment0.clone(),
                index: idx0,
                encrypted_output: s.note_ct0.clone(),
                mvk_tag: s.mvk_tag0.clone(),
            }
            .publish(&env);
            NewCommitmentEvent {
                commitment: s.out_commitment1.clone(),
                index: idx1,
                encrypted_output: s.note_ct1.clone(),
                mvk_tag: s.mvk_tag1.clone(),
            }
            .publish(&env);
        }

        Ok(())
    }

    // ========================================================= withdraw ====

    /// Unshield (on-chain verb: `withdraw`): spend a note to release public
    /// tokens to `to`, with an ASP non-membership ("proof-of-innocence")
    /// obligation inside the circuit.
    ///
    /// Public inputs (must match the UNSHIELD circuit declaration order):
    /// `[root, asset_id, nullifier, public_amount, change_commitment,
    ///   ext_data_hash, asp_non_membership_root, change_mvk_tag]`
    #[allow(clippy::too_many_arguments)]
    pub fn withdraw(
        env: Env,
        submitter: Address,
        root: U256,
        nullifier: U256,
        change_commitment: U256,
        amount: i128,
        to: Address,
        change_mvk_tag: U256,
        change_note_ct: Bytes,
        change_mvk_ct: Bytes,
        asp_non_membership_root: U256,
        registered_mvk_root: U256,
        proof: Groth16Proof,
    ) -> Result<(), Error> {
        submitter.require_auth();
        Self::require_not_paused(&env)?;

        if amount <= 0 {
            return Err(Error::WrongAmount);
        }

        let merkle_addr: Address = Self::get(&env, &DataKey::MerkleTree)?;
        let merkle = MerkleClient::new(&env, &merkle_addr);
        if !merkle.is_known_root(&root) {
            return Err(Error::UnknownRoot);
        }

        // Idempotent replay: an already-spent nullifier is a no-op success —
        // never a second debit.
        let ns_addr: Address = Self::get(&env, &DataKey::NullifierSet)?;
        let ns = NullifierSetClient::new(&env, &ns_addr);
        if ns.is_spent(&nullifier) {
            return Ok(());
        }

        // Proof-of-innocence must target the registry's current deny-root.
        let aspn_addr: Address = Self::get(&env, &DataKey::AspNonMembership)?;
        let current_deny_root = AspNonMembershipClient::new(&env, &aspn_addr).get_root();
        if asp_non_membership_root != current_deny_root {
            return Err(Error::WrongAspRoot);
        }

        let ext_hash =
            Self::hash_withdraw_ext(&env, &to, &change_note_ct, &change_mvk_ct);

        let modulus = bn256_modulus(&env);
        let asset_id: U256 = Self::get(&env, &DataKey::AssetId)?;
        let mut public_inputs: Vec<Bn254Fr> = Vec::new(&env);
        Self::push_input(&env, &mut public_inputs, &root, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &asset_id, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &nullifier, &modulus)?;
        Self::push_input(
            &env,
            &mut public_inputs,
            &Self::i128_to_u256(&env, amount)?,
            &modulus,
        )?;
        Self::push_input(&env, &mut public_inputs, &change_commitment, &modulus)?;
        Self::push_input(&env, &mut public_inputs, &ext_hash, &modulus)?;
        Self::push_input(
            &env,
            &mut public_inputs,
            &asp_non_membership_root,
            &modulus,
        )?;
        Self::push_input(&env, &mut public_inputs, &change_mvk_tag, &modulus)?;
        Self::check_mvk_root(&env, &registered_mvk_root)?;
        Self::push_input(&env, &mut public_inputs, &registered_mvk_root, &modulus)?;

        Self::verify(&env, VK_UNSHIELD, &proof, &public_inputs)?;

        // Turnstile: a withdrawal can never exceed the net shielded supply. With
        // sound circuits this is always satisfied; if it ever isn't, it caps the
        // damage of a forged proof to the funds actually deposited (no mint).
        let total: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalShielded)
            .unwrap_or(0);
        if amount > total {
            return Err(Error::InsufficientPoolSupply);
        }
        // `checked_sub` for symmetry with shield's `checked_add`; `amount <= total`
        // above already rules out underflow, but never trust that implicitly.
        let new_total = total.checked_sub(amount).ok_or(Error::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::TotalShielded, &new_total);
        soroban_utils::bump_persistent(&env, &DataKey::TotalShielded);

        // Spend, insert change, release funds.
        //
        // ORDERING IS SAFE under Soroban's atomic-trap semantics: these are
        // NON-`try_` cross-contract calls, so any sub-call that returns `Err`
        // (or the token transfer failing) TRAPS and reverts the ENTIRE
        // transaction — including the nullifier spend and turnstile decrement
        // above. There is no partial-state / second-withdrawal window (this is
        // not EVM partial-revert). Fail-closed is the default; using the `try_`
        // variants here would only let us swallow an error we must not swallow.
        ns.spend(&nullifier);
        NewNullifierEvent {
            nullifier: nullifier.clone(),
        }
        .publish(&env);

        let idx = merkle.insert_leaf(&change_commitment);

        let token: Address = Self::get(&env, &DataKey::Token)?;
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);

        let viewkey: Address = Self::get(&env, &DataKey::ViewkeyAnchor)?;
        ViewkeyAnchorClient::new(&env, &viewkey).bind_mvk(&change_mvk_tag, &change_mvk_ct);

        WithdrawEvent {
            to,
            amount,
            nullifier,
        }
        .publish(&env);
        NewCommitmentEvent {
            commitment: change_commitment,
            index: idx,
            encrypted_output: change_note_ct,
            mvk_tag: change_mvk_tag,
        }
        .publish(&env);

        Ok(())
    }

    // ============================================================ admin ====

    pub fn pause(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&DataKey::IsPaused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&DataKey::IsPaused, &false);
        Ok(())
    }

    pub fn set_deposit_cap(env: Env, cap: i128) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::MaximumDepositAmount, &cap);
        Ok(())
    }

    /// Governed verifier rotation (BENZO §10.4 upgrade path). Points the pool
    /// at a new (e.g. hardened-circuit) verifier without touching custody,
    /// tree, or nullifier state. Admin-gated; a multisig in production.
    pub fn set_verifier(env: Env, new_verifier: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&DataKey::Verifier, &new_verifier);
        VerifierRotatedEvent {
            new_verifier,
        }
        .publish(&env);
        Ok(())
    }

    /// Configure the authorized-MVK registry (a merkle instance). Admin-only.
    /// Once set, shield/transfer/withdraw require `registered_mvk_root` to be a
    /// known root of this registry — the on-chain half of the audit P0 that pins
    /// the in-circuit MVK membership to the real registry.
    pub fn set_mvk_registry(env: Env, registry: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&DataKey::MvkRegistry, &registry);
        Ok(())
    }

    /// Validate `registered_mvk_root` against the configured authorized-MVK
    /// registry. If no registry is configured the check is skipped (legacy
    /// deployments), but a configured registry makes the in-circuit MVK
    /// membership meaningful by pinning the root to the real registry.
    fn check_mvk_root(env: &Env, registered_mvk_root: &U256) -> Result<(), Error> {
        if let Some(registry) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::MvkRegistry)
            && !MerkleClient::new(env, &registry).is_known_root(registered_mvk_root)
        {
            return Err(Error::WrongMvkRoot);
        }
        Ok(())
    }

    /// The verifier contract this pool routes proofs to.
    pub fn verifier(env: Env) -> Result<Address, Error> {
        Self::get(&env, &DataKey::Verifier)
    }

    // ========================================================== getters ====

    /// The asset domain tag bound into every note commitment.
    pub fn asset_id(env: Env) -> Result<U256, Error> {
        Self::get(&env, &DataKey::AssetId)
    }

    /// Deterministic field-element encoding of an Address:
    /// keccak256(address XDR) mod p.
    pub fn address_scalar(env: Env, address: Address) -> U256 {
        Self::address_to_scalar(&env, &address)
    }

    /// Net shielded supply (Σ deposits − Σ withdrawals). Invariant: the pool's
    /// custodied USDC balance is always ≥ this, and a withdrawal can never
    /// exceed it (the turnstile backstop).
    pub fn total_shielded(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalShielded)
            .unwrap_or(0)
    }

    /// Ext-data hash for a transfer (binds relayer, fee, and ciphertexts).
    pub fn transfer_ext_hash(
        env: Env,
        relayer: Address,
        fee: i128,
        note_ct0: Bytes,
        note_ct1: Bytes,
        mvk_ct0: Bytes,
        mvk_ct1: Bytes,
    ) -> U256 {
        Self::hash_transfer_ext(&env, &relayer, fee, &note_ct0, &note_ct1, &mvk_ct0, &mvk_ct1)
    }

    /// Ext-data hash for a withdraw (binds recipient and change ciphertexts).
    pub fn withdraw_ext_hash(env: Env, to: Address, change_note_ct: Bytes, change_mvk_ct: Bytes) -> U256 {
        Self::hash_withdraw_ext(&env, &to, &change_note_ct, &change_mvk_ct)
    }

    // ========================================================= internal ====

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = Self::get(env, &DataKey::Admin)?;
        admin.require_auth();
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = Self::get(env, &DataKey::IsPaused)?;
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &DataKey,
    ) -> Result<T, Error> {
        let val = env
            .storage()
            .persistent()
            .get(key)
            .ok_or(Error::NotInitialized)?;
        // Config singletons are written once at init and read on every op; keep
        // them from being archived under CAP-0078 state archival.
        soroban_utils::bump_persistent(env, key);
        Ok(val)
    }

    fn verify(
        env: &Env,
        vk_id: Symbol,
        proof: &Groth16Proof,
        public_inputs: &Vec<Bn254Fr>,
    ) -> Result<(), Error> {
        if proof.is_empty() {
            return Err(Error::InvalidProof);
        }
        let verifier: Address = Self::get(env, &DataKey::Verifier)?;
        // Use the fallible (`try_`) client so a non-verifying proof surfaces the
        // pool's typed `InvalidProof` instead of trapping the whole invocation.
        // The verifier returns `Ok(true)` only on success; `Ok(false)` is
        // unreachable but mapped defensively, and any verifier/host error ⇒
        // `InvalidProof` (fail closed).
        match VerifierClient::new(env, &verifier).try_verify_proof(&vk_id, proof, public_inputs) {
            Ok(Ok(true)) => Ok(()),
            _ => Err(Error::InvalidProof),
        }
    }

    /// Batched analogue of `verify`: one cross-call that verifies N proofs sharing
    /// `vk_id` via the verifier's random-linear-combination check. Same fail-closed
    /// contract — anything but `Ok(Ok(true))` ⇒ `InvalidProof`.
    fn verify_batch(
        env: &Env,
        vk_id: Symbol,
        proofs: &Vec<Groth16Proof>,
        pub_inputs: &Vec<Vec<Bn254Fr>>,
    ) -> Result<(), Error> {
        let verifier: Address = Self::get(env, &DataKey::Verifier)?;
        match VerifierClient::new(env, &verifier).try_verify_batch(&vk_id, proofs, pub_inputs) {
            Ok(Ok(true)) => Ok(()),
            _ => Err(Error::InvalidProof),
        }
    }

    /// Linear membership check over a small `Vec<U256>` (batch sizes are tens of
    /// items, so O(n) scan is cheaper than building a Map).
    fn vec_contains(seen: &Vec<U256>, x: &U256) -> bool {
        for v in seen.iter() {
            if &v == x {
                return true;
            }
        }
        false
    }

    fn push_input(
        env: &Env,
        inputs: &mut Vec<Bn254Fr>,
        value: &U256,
        modulus: &U256,
    ) -> Result<(), Error> {
        if value >= modulus {
            return Err(Error::NonCanonicalPublicInput);
        }
        let mut buf = [0u8; 32];
        value.to_be_bytes().copy_into_slice(&mut buf);
        inputs.push_back(Bn254Fr::from_bytes(BytesN::from_array(env, &buf)));
        Ok(())
    }

    fn i128_to_u256(env: &Env, v: i128) -> Result<U256, Error> {
        if v < 0 {
            return Err(Error::WrongAmount);
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let hi = (v >> 64) as u64;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let lo = v as u64;
        Ok(U256::from_parts(env, 0, 0, hi, lo))
    }

    /// keccak256(address XDR) reduced mod p — deterministic and reproducible
    /// off-chain from the address's ScVal XDR bytes.
    fn address_to_scalar(env: &Env, address: &Address) -> U256 {
        let payload = address.clone().to_xdr(env);
        let digest: BytesN<32> = env.crypto().keccak256(&payload).into();
        let digest_u256 = U256::from_be_bytes(env, &Bytes::from(digest));
        digest_u256.rem_euclid(&bn256_modulus(env))
    }

    fn append_lp(env: &Env, out: &mut Bytes, chunk: &Bytes) {
        let len = chunk.len();
        out.append(&Bytes::from_array(env, &len.to_be_bytes()));
        out.append(chunk);
    }

    /// keccak256 over a length-prefixed concatenation, reduced mod p.
    /// Trivially reproducible in any language (no XDR struct encoding).
    fn hash_ext_preimage(env: &Env, preimage: &Bytes) -> U256 {
        let digest: BytesN<32> = env.crypto().keccak256(preimage).into();
        let digest_u256 = U256::from_be_bytes(env, &Bytes::from(digest));
        digest_u256.rem_euclid(&bn256_modulus(env))
    }

    fn hash_transfer_ext(
        env: &Env,
        relayer: &Address,
        fee: i128,
        note_ct0: &Bytes,
        note_ct1: &Bytes,
        mvk_ct0: &Bytes,
        mvk_ct1: &Bytes,
    ) -> U256 {
        let mut pre = Bytes::new(env);
        Self::append_lp(env, &mut pre, &relayer.clone().to_xdr(env));
        pre.append(&Bytes::from_array(env, &fee.to_be_bytes()));
        Self::append_lp(env, &mut pre, note_ct0);
        Self::append_lp(env, &mut pre, note_ct1);
        Self::append_lp(env, &mut pre, mvk_ct0);
        Self::append_lp(env, &mut pre, mvk_ct1);
        Self::hash_ext_preimage(env, &pre)
    }

    fn hash_withdraw_ext(
        env: &Env,
        to: &Address,
        change_note_ct: &Bytes,
        change_mvk_ct: &Bytes,
    ) -> U256 {
        let mut pre = Bytes::new(env);
        Self::append_lp(env, &mut pre, &to.clone().to_xdr(env));
        Self::append_lp(env, &mut pre, change_note_ct);
        Self::append_lp(env, &mut pre, change_mvk_ct);
        Self::hash_ext_preimage(env, &pre)
    }
}
