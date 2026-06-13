//! Benzo pool contract implementation.

use contract_types::{Groth16Error, Groth16Proof};
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
}

// ---- cross-contract clients ----

#[contractclient(crate_path = "soroban_sdk", name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(
        env: Env,
        vk_id: Symbol,
        proof: Groth16Proof,
        public_inputs: Vec<Bn254Fr>,
    ) -> Result<bool, Groth16Error>;
}

#[contractclient(crate_path = "soroban_sdk", name = "MerkleClient")]
pub trait MerkleInterface {
    fn insert_leaf(env: Env, leaf: U256) -> Result<u32, soroban_sdk::Error>;
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

        Self::verify(&env, VK_SHIELD, &proof, &public_inputs)?;

        // Pull the public deposit into custody.
        let token: Address = Self::get(&env, &DataKey::Token)?;
        TokenClient::new(&env, &token).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );

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

        Self::verify(&env, VK_UNSHIELD, &proof, &public_inputs)?;

        // Spend, insert change, release funds.
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
        env.storage()
            .persistent()
            .get(key)
            .ok_or(Error::NotInitialized)
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
        let ok = VerifierClient::new(env, &verifier).verify_proof(&vk_id, proof, public_inputs);
        if ok { Ok(()) } else { Err(Error::InvalidProof) }
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
