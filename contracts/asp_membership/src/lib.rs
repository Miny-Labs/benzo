//! ASP Membership Contract
//!
//! This contract implements a Merkle tree-based membership system using
//! Poseidon2 hash function for Anonymous Service Provider (ASP) membership
//! tracking. The contract maintains a Merkle tree where each leaf represents a
//! member, and the root serves as a commitment to the entire membership set.
#![no_std]
use soroban_sdk::{
    Address, BytesN, Env, Symbol, U256, Vec, contract, contractclient, contracterror, contractevent,
    contractimpl, contracttype, crypto::bn254::Bn254Fr,
};
use soroban_utils::{get_zeroes, poseidon2_compress};
use contract_types::Groth16Proof;

/// Cross-contract interface to the Groth16 verifier (for proof-gated admission).
#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(
        env: Env,
        vk_id: Symbol,
        proof: Groth16Proof,
        public_inputs: Vec<Bn254Fr>,
    ) -> Result<bool, soroban_sdk::Error>;
}

/// Cross-contract interface to the authorized-issuer registry — admit only
/// accepts credentials whose `issuerRegistryRoot` is a root this registry knows
/// (so a prover can't supply a self-made root with an unauthorized issuer).
#[contractclient(name = "IssuerRegistryClient")]
pub trait IssuerRegistryInterface {
    fn is_known_root(env: Env, root: U256) -> Result<bool, soroban_sdk::Error>;
}

soroban_sdk::contractmeta!(key = "binver", val = "0.1.0");
soroban_sdk::contractmeta!(key = "name", val = "benzo-asp-membership");

/// Storage keys for contract persistent data
#[contracttype]
#[derive(Clone, Debug)]
enum DataKey {
    /// Administrator address with permissions to modify the tree
    Admin,
    /// Filled subtree hashes at each level (indexed by level)
    FilledSubtrees(u32),
    /// Zero hash values for each level (indexed by level)
    Zeroes(u32),
    /// Number of levels in the Merkle tree
    Levels,
    /// Next available index for leaf insertion
    NextIndex,
    /// Current Merkle root
    Root,
    /// Whether admin permission is required to insert a leaf
    AdminInsertOnly,
    /// The Groth16 verifier contract (for proof-gated admission)
    Verifier,
    /// The vk_id of the kyc_credential circuit in the verifier
    KycVkId,
    /// Minimum assurance tier (credType) required for proof-gated admission
    MinTier,
    /// Optional authorized-issuer registry; when set, admit checks issuerRegistryRoot
    IssuerRegistry,
}

/// Contract error types
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this operation
    NotAuthorized = 1,
    /// Merkle tree has reached maximum capacity
    MerkleTreeFull = 2,
    /// Wrong Number of levels specified
    WrongLevels = 3,
    /// The contract has not been yet initialized
    NotInitialized = 4,
    /// Arithmetic overflow occurred
    Overflow = 5,
    /// The KYC credential proof did not verify
    InvalidCredential = 6,
    /// No KYC verifier/vk_id has been configured for proof-gated admission
    KycNotConfigured = 7,
    /// The credential's assurance tier is below the corridor's required minimum
    InsufficientTier = 8,
}

/// Event emitted when a new leaf is added to the Merkle tree
#[contractevent(topics = ["LeafAdded"])]
struct LeafAddedEvent {
    /// The leaf value that was inserted
    leaf: U256,
    /// Index position where the leaf was inserted
    index: u64,
    /// New Merkle root after insertion
    root: U256,
}

/// ASP Membership contract
#[contract]
pub struct ASPMembership;

#[contractimpl]
impl ASPMembership {
    /// Constructor: initialize the ASP Membership contract
    ///
    /// Creates a new Merkle tree with the specified number of levels and sets
    /// the admin address. The tree is initialized with zero hashes at each
    /// level.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `admin` - Address of the contract administrator
    /// * `levels` - Number of levels in the Merkle tree (must be in range
    ///   [1..32])
    ///
    /// # Returns
    /// Returns `Ok(())` on success, or an error if already initialized
    ///
    /// # Panics
    /// Panics if levels is 0 or greater than 32
    pub fn __constructor(env: Env, admin: Address, levels: u32) -> Result<(), Error> {
        let store = env.storage().persistent();

        if levels == 0 || levels > 32 {
            return Err(Error::WrongLevels);
        }

        // Initialize admin and tree parameters
        store.set(&DataKey::Admin, &admin);
        store.set(&DataKey::Levels, &levels);
        store.set(&DataKey::NextIndex, &0u64);
        store.set(&DataKey::AdminInsertOnly, &true);

        // Initialize an empty tree with zero hashes at each level
        let zeros: Vec<U256> = get_zeroes(&env);
        for lvl in 0..=levels {
            let zero_val = zeros.get(lvl).ok_or(Error::NotInitialized)?;
            store.set(&DataKey::FilledSubtrees(lvl), &zero_val);
            store.set(&DataKey::Zeroes(lvl), &zero_val);
        }

        // Set initial root to the zero hash at the top level
        let root_val = zeros.get(levels).ok_or(Error::NotInitialized)?;
        store.set(&DataKey::Root, &root_val);

        Ok(())
    }

    /// Update the contract administrator
    ///
    /// Changes the admin address to a new address. Only the current admin
    /// can call this function.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `new_admin` - Address of the new administrator
    pub fn update_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        if !env.storage().persistent().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        soroban_utils::update_admin(&env, &DataKey::Admin, &new_admin);
        Ok(())
    }

    /// Set whether admin permission is required to insert a leaf
    ///
    /// When `admin_only` is true (default), only the admin can insert leaves.
    /// When false, anyone can insert leaves. Only the admin can change this
    /// setting.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `admin_only` - Whether admin permission is required for leaf insertion
    pub fn set_admin_insert_only(env: Env, admin_only: bool) -> Result<(), Error> {
        let store = env.storage().persistent();
        let admin: Address = store.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        store.set(&DataKey::AdminInsertOnly, &admin_only);
        Ok(())
    }

    /// Get the current Merkle root
    ///
    /// Returns the current root hash of the Merkle tree.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// The current Merkle root as U256
    ///
    /// # Panics
    /// Panics if the contract has not been initialized
    pub fn get_root(env: Env) -> Result<U256, Error> {
        let root: U256 = env
            .storage()
            .persistent()
            .get(&DataKey::Root)
            .ok_or(Error::NotInitialized)?;
        // CAP-0078: the pool reads this allow-root cross-contract on every
        // shield, so keep it from being archived out from under the hot path.
        soroban_utils::bump_persistent(&env, &DataKey::Root);
        Ok(root)
    }

    /// Hash two U256 values using Poseidon2 compression
    ///
    /// Computes the Poseidon2 hash of two field elements in compression mode.
    /// This is the core hashing function used for Merkle tree operations.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `left` - Left input value
    /// * `right` - Right input value
    ///
    /// # Returns
    /// The Poseidon2 hash result as U256
    pub fn hash_pair(env: &Env, left: U256, right: U256) -> U256 {
        poseidon2_compress(env, left, right)
    }

    /// Insert a new leaf into the Merkle tree
    ///
    /// Adds a new member to the Merkle tree and updates the root. The leaf is
    /// inserted at the next available index and the tree is updated efficiently
    /// by only recomputing the hashes along the path to the root. If
    /// `admin_insert_only` is enabled (the default), only the admin can insert
    /// leaves; otherwise, anyone can call this function.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `leaf` - The leaf value to insert (typically a commitment or hash)
    ///
    /// # Returns
    /// Returns `Ok(())` on success, or `MerkleTreeFull` if the tree is at
    /// capacity
    pub fn insert_leaf(env: Env, leaf: U256) -> Result<(), Error> {
        let store = env.storage().persistent();
        let admin_only: bool = store.get(&DataKey::AdminInsertOnly).unwrap_or(true);
        if admin_only {
            let admin: Address = store.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
            admin.require_auth();
        }

        Self::do_insert(&env, leaf)
    }

    /// Core incremental-tree insert (no auth). Shared by `insert_leaf`
    /// (admin/permissionless) and `admit_by_proof` (where the proof is the
    /// authorization).
    fn do_insert(env: &Env, leaf: U256) -> Result<(), Error> {
        let store = env.storage().persistent();
        let levels: u32 = store.get(&DataKey::Levels).ok_or(Error::NotInitialized)?;
        let actual_index: u64 = store
            .get(&DataKey::NextIndex)
            .ok_or(Error::NotInitialized)?;
        let mut current_index = actual_index;

        // Check if tree is full (capacity is 2^levels leaves)
        if current_index >= 1u64.checked_shl(levels).ok_or(Error::MerkleTreeFull)? {
            return Err(Error::MerkleTreeFull);
        }
        let mut current_hash = leaf.clone();

        // Update tree by recomputing hashes along the path to root
        for lvl in 0..levels {
            let is_right = current_index & 1 == 1;
            if is_right {
                let left: U256 = store
                    .get(&DataKey::FilledSubtrees(lvl))
                    .ok_or(Error::NotInitialized)?;
                current_hash = poseidon2_compress(env, left, current_hash);
            } else {
                store.set(&DataKey::FilledSubtrees(lvl), &current_hash);
                let zero_val: U256 = store
                    .get(&DataKey::Zeroes(lvl))
                    .ok_or(Error::NotInitialized)?;
                current_hash = poseidon2_compress(env, current_hash, zero_val);
            }
            current_index >>= 1;
        }

        store.set(&DataKey::Root, &current_hash);
        LeafAddedEvent {
            leaf: leaf.clone(),
            index: actual_index,
            root: current_hash,
        }
        .publish(env);
        store.set(
            &DataKey::NextIndex,
            &(actual_index.checked_add(1).ok_or(Error::Overflow)?),
        );
        Ok(())
    }

    /// Configure the Groth16 verifier + kyc_credential vk_id used for
    /// proof-gated admission. Admin-only.
    pub fn set_kyc_verifier(env: Env, verifier: Address, vk_id: Symbol) -> Result<(), Error> {
        let store = env.storage().persistent();
        let admin: Address = store.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        store.set(&DataKey::Verifier, &verifier);
        store.set(&DataKey::KycVkId, &vk_id);
        Ok(())
    }

    /// Set the minimum assurance tier required to admit by proof (risk-based KYC:
    /// 0 = anonymous, 1 = unique-human, 2 = verified-ID, 3 = full). Admin-only.
    pub fn set_min_tier(env: Env, min_tier: u32) -> Result<(), Error> {
        let store = env.storage().persistent();
        let admin: Address = store.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        store.set(&DataKey::MinTier, &min_tier);
        Ok(())
    }

    /// Wire the authorized-issuer registry. When set, `admit_by_proof` requires
    /// the credential's `issuerRegistryRoot` (public input #0) to be a root this
    /// registry knows — so only registered issuers can admit. Admin-only.
    pub fn set_issuer_registry(env: Env, registry: Address) -> Result<(), Error> {
        let store = env.storage().persistent();
        let admin: Address = store.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        store.set(&DataKey::IssuerRegistry, &registry);
        Ok(())
    }

    /// Admit a holder into the allow-set by a valid KYC-credential proof — the
    /// proof-gated replacement for the operator-trusted insert. The proof IS the
    /// authorization (no admin auth), and no PII touches the chain.
    ///
    /// `admit_leaf` is cross-checked to equal public input #6 of the
    /// kyc_credential circuit (order: [issuerRegistryRoot, credType, currentTime,
    /// scope, identityNullifier, addressBinding, admitLeaf]) so the leaf actually
    /// inserted is the one the proof attests; the proof is then verified
    /// fail-closed via the configured verifier.
    ///
    /// # Security Warning
    /// This function intentionally SKIPS `require_auth()` — the KYC-credential
    /// proof *is* the authorization. Soundness therefore rests on three checks,
    /// all of which fail closed: (1) a verifier + KYC `vk_id` must be configured
    /// (`KycNotConfigured` otherwise); (2) `admit_leaf` must equal public input
    /// #6 (`InvalidCredential` otherwise), so a caller cannot insert a different
    /// leaf than the proof attests; (3) `try_verify_proof` must return
    /// `Ok(Ok(true))` — any other result, including an invoke error, maps to
    /// `InvalidCredential` and NO insertion. Do not add an early `do_insert`
    /// path here.
    pub fn admit_by_proof(
        env: Env,
        proof: Groth16Proof,
        public_inputs: Vec<Bn254Fr>,
        admit_leaf: U256,
        claimed_tier: u32,
        issuer_registry_root: U256,
    ) -> Result<(), Error> {
        let store = env.storage().persistent();
        let verifier: Address = store.get(&DataKey::Verifier).ok_or(Error::KycNotConfigured)?;
        let vk_id: Symbol = store.get(&DataKey::KycVkId).ok_or(Error::KycNotConfigured)?;

        // admit_leaf must equal public input #6 (so the inserted leaf is the one
        // the proof attests). Reuse the canonical U256 -> Bn254Fr encoding.
        let mut buf = [0u8; 32];
        admit_leaf.to_be_bytes().copy_into_slice(&mut buf);
        let expected = Bn254Fr::from_bytes(BytesN::from_array(&env, &buf));
        let pi6 = public_inputs.get(6).ok_or(Error::InvalidCredential)?;
        if pi6 != expected {
            return Err(Error::InvalidCredential);
        }

        // Bind the declared assurance tier to public input #1 (credType) — the
        // issuer signed the tier in-circuit, so the caller cannot claim a higher
        // tier than the credential actually proves.
        let mut tbuf = [0u8; 32];
        tbuf[28..32].copy_from_slice(&claimed_tier.to_be_bytes());
        let tier_fr = Bn254Fr::from_bytes(BytesN::from_array(&env, &tbuf));
        let pi1 = public_inputs.get(1).ok_or(Error::InvalidCredential)?;
        if pi1 != tier_fr {
            return Err(Error::InvalidCredential);
        }
        // Enforce the corridor's minimum assurance tier (risk-based KYC: most
        // actions need only a low tier; off-ramp/high-value require more).
        let min_tier: u32 = store.get(&DataKey::MinTier).unwrap_or(0);
        if claimed_tier < min_tier {
            return Err(Error::InsufficientTier);
        }

        // Bind the declared issuer-registry root to public input #0
        // (issuerRegistryRoot) and, when a registry is wired, require it to be a
        // root that registry knows — so a prover can't supply a self-made root
        // with an unauthorized issuer. Fail-closed.
        let mut rbuf = [0u8; 32];
        issuer_registry_root.to_be_bytes().copy_into_slice(&mut rbuf);
        let root_fr = Bn254Fr::from_bytes(BytesN::from_array(&env, &rbuf));
        let pi0 = public_inputs.get(0).ok_or(Error::InvalidCredential)?;
        if pi0 != root_fr {
            return Err(Error::InvalidCredential);
        }
        if let Some(registry) = store.get::<DataKey, Address>(&DataKey::IssuerRegistry) {
            let known = matches!(
                IssuerRegistryClient::new(&env, &registry).try_is_known_root(&issuer_registry_root),
                Ok(Ok(true))
            );
            if !known {
                return Err(Error::InvalidCredential);
            }
        }

        // Fail-closed: a non-verifying proof (verifier returns InvalidProof) or
        // any invoke error maps to InvalidCredential — never an admission.
        let verified = matches!(
            VerifierClient::new(&env, &verifier).try_verify_proof(&vk_id, &proof, &public_inputs),
            Ok(Ok(true))
        );
        if !verified {
            return Err(Error::InvalidCredential);
        }

        Self::do_insert(&env, admit_leaf)
    }
}

mod test;
