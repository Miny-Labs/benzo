#![no_std]

//! Benzo authorized-issuer registry.
//!
//! An append-only, root-history Merkle accumulator of the **KYC issuer key-ids
//! authorized to sign credentials**. The `kyc_credential` circuit proves, in
//! zero knowledge, that the issuer who signed a credential is a member of this
//! registry under a recent root (`issuerRegistryRoot`) — so a credential is only
//! admitted if it was signed by a genuinely-authorized issuer (Self-backed
//! enclave, a document IDV, etc.), not a key the prover made up.
//!
//! Leaf = the issuer key-id `Poseidon(issuerAx, issuerAy)` inserted DIRECTLY
//! (matching the circuit's `itree.leaf <== ik.out` and the SDK's
//! `MerkleTreeMirror.insert(issuerKeyId)`). The tree is a Poseidon2 twin of
//! `benzo-merkle` (frontier + 128-root ring), so `is_known_root` works unchanged.
//!
//! Also pins the **attested enclave measurement** (mrenclave): the issuer runs
//! inside a Phala TEE, and pinning its measurement here lets governance assert
//! "credentials are only signed by the attested issuer build." Admin-gated; the
//! admin should be a multisig/timelock before mainnet.

use soroban_sdk::{
    Address, Env, U256, Vec, contract, contracterror, contractevent, contractimpl, contracttype,
};
use soroban_utils::{get_zeroes, poseidon2_compress};

soroban_sdk::contractmeta!(key = "binver", val = "0.1.0");
soroban_sdk::contractmeta!(key = "name", val = "benzo-issuer-registry");

/// Number of recent roots accepted (canonical ROOT_HISTORY = 128).
pub const ROOT_HISTORY_SIZE: u32 = 128;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this operation
    NotAuthorized = 1,
    /// Registry has reached maximum capacity
    RegistryFull = 2,
    /// Invalid tree levels configuration (must be 1..=32)
    WrongLevels = 3,
    /// Contract is not initialized
    NotInitialized = 4,
    /// Arithmetic overflow occurred
    Overflow = 5,
    /// This issuer key-id is already registered
    DuplicateIssuer = 6,
    /// `issuer_key_id` is zero
    ZeroIssuer = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    /// Administrator (vets + authorizes issuers; should be multisig pre-mainnet)
    Admin,
    /// Number of levels in the Merkle tree
    Levels,
    /// Current position in the root history ring buffer
    CurrentRootIndex,
    /// Next available leaf index
    NextIndex,
    /// Right-frontier subtree hash at each level
    FilledSubtree(u32),
    /// Cached zero hash at each level
    Zeroes(u32),
    /// Historical roots ring buffer (slot -> root)
    Root(u32),
    /// Membership index for the ring buffer (root -> present): O(1) is_known_root
    KnownRoot(U256),
    /// Presence index for registered issuer key-ids (rejects double-registration)
    IssuerSeen(U256),
    /// Pinned attested enclave measurement (mrenclave) of the issuer build
    AttestedMeasurement,
}

/// Emitted on every registration so indexers can mirror the registry.
#[contractevent(topics = ["IssuerRegistered"])]
#[derive(Clone)]
pub struct IssuerRegisteredEvent {
    /// The registered issuer key-id (Poseidon(issuerAx, issuerAy)) — also the leaf
    pub issuer_key_id: U256,
    /// Index position in the tree
    pub index: u32,
    /// New registry root after insertion
    pub root: U256,
}

#[contract]
pub struct BenzoIssuerRegistry;

#[contractimpl]
impl BenzoIssuerRegistry {
    /// Initialize. `levels` is tree depth (1..=32).
    pub fn __constructor(env: Env, admin: Address, levels: u32) -> Result<(), Error> {
        if levels == 0 || levels > 32 {
            return Err(Error::WrongLevels);
        }
        let storage = env.storage().persistent();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Levels, &levels);

        let zeros: Vec<U256> = get_zeroes(&env);
        for i in 0..=levels {
            let z: U256 = zeros.get(i).ok_or(Error::WrongLevels)?;
            storage.set(&DataKey::FilledSubtree(i), &z);
            storage.set(&DataKey::Zeroes(i), &z);
        }
        let root_0: U256 = zeros.get(levels).ok_or(Error::WrongLevels)?;
        storage.set(&DataKey::Root(0), &root_0);
        storage.set(&DataKey::KnownRoot(root_0), &true);
        storage.set(&DataKey::CurrentRootIndex, &0u32);
        storage.set(&DataKey::NextIndex, &0u32);
        Ok(())
    }

    /// Update the administrator. Current-admin-only.
    pub fn update_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// Pin the attested enclave measurement (mrenclave) of the authorized issuer
    /// build. Admin-only. Credentials should only be trusted from this build.
    pub fn set_attested_measurement(env: Env, measurement: U256) -> Result<(), Error> {
        let storage = env.storage().persistent();
        let admin: Address = storage.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        storage.set(&DataKey::AttestedMeasurement, &measurement);
        Ok(())
    }

    /// The pinned attested enclave measurement (zero if none set).
    pub fn attested_measurement(env: Env) -> U256 {
        env.storage()
            .persistent()
            .get(&DataKey::AttestedMeasurement)
            .unwrap_or_else(|| U256::from_u32(&env, 0))
    }

    /// Authorize an issuer: append its key-id as a leaf. Admin-only. The key-id
    /// is `Poseidon(issuerAx, issuerAy)` — the exact value the circuit proves
    /// membership of. Must be non-zero and not already registered.
    pub fn register_issuer(env: Env, issuer_key_id: U256) -> Result<u32, Error> {
        let storage = env.storage().persistent();
        let admin: Address = storage.get(&DataKey::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if issuer_key_id == U256::from_u32(&env, 0) {
            return Err(Error::ZeroIssuer);
        }
        if storage.has(&DataKey::IssuerSeen(issuer_key_id.clone())) {
            return Err(Error::DuplicateIssuer);
        }

        let levels: u32 = storage.get(&DataKey::Levels).ok_or(Error::NotInitialized)?;
        let next_index: u32 = storage.get(&DataKey::NextIndex).ok_or(Error::NotInitialized)?;
        let max_leaves = 1u64.checked_shl(levels).ok_or(Error::WrongLevels)?;
        if u64::from(next_index) >= max_leaves {
            return Err(Error::RegistryFull);
        }

        // Leaf is the issuer key-id directly (matches the circuit + SDK mirror).
        let mut current_hash = issuer_key_id.clone();
        let mut current_index = next_index;
        for lvl in 0..levels {
            if current_index & 1 == 0 {
                storage.set(&DataKey::FilledSubtree(lvl), &current_hash);
                let zero: U256 = storage.get(&DataKey::Zeroes(lvl)).ok_or(Error::NotInitialized)?;
                current_hash = poseidon2_compress(&env, current_hash, zero);
            } else {
                let left: U256 = storage.get(&DataKey::FilledSubtree(lvl)).ok_or(Error::NotInitialized)?;
                current_hash = poseidon2_compress(&env, left, current_hash);
            }
            current_index >>= 1;
        }

        let root_index: u32 = storage.get(&DataKey::CurrentRootIndex).ok_or(Error::NotInitialized)?;
        let new_root_index = root_index.checked_add(1).ok_or(Error::Overflow)? % ROOT_HISTORY_SIZE;
        if let Some(evicted) = storage.get::<DataKey, U256>(&DataKey::Root(new_root_index)) {
            storage.remove(&DataKey::KnownRoot(evicted));
        }
        storage.set(&DataKey::Root(new_root_index), &current_hash);
        storage.set(&DataKey::KnownRoot(current_hash.clone()), &true);
        storage.set(&DataKey::IssuerSeen(issuer_key_id.clone()), &true);
        storage.set(&DataKey::CurrentRootIndex, &new_root_index);
        storage.set(
            &DataKey::NextIndex,
            &(next_index.checked_add(1).ok_or(Error::Overflow)?),
        );

        IssuerRegisteredEvent { issuer_key_id, index: next_index, root: current_hash.clone() }
            .publish(&env);
        Ok(next_index)
    }

    /// Current (most recent) registry root.
    pub fn current_root(env: Env) -> Result<U256, Error> {
        let storage = env.storage().persistent();
        let idx: u32 = storage.get(&DataKey::CurrentRootIndex).ok_or(Error::NotInitialized)?;
        let root = storage.get(&DataKey::Root(idx)).ok_or(Error::NotInitialized)?;
        soroban_utils::bump_persistent(&env, &DataKey::Root(idx));
        Ok(root)
    }

    /// True if `root` is in the recent-root ring buffer (zero is never valid).
    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        if root == U256::from_u32(&env, 0) {
            return Ok(false);
        }
        let key = DataKey::KnownRoot(root);
        let known = env.storage().persistent().has(&key);
        if known {
            soroban_utils::bump_persistent(&env, &key);
        }
        Ok(known)
    }

    /// Is this issuer key-id already registered?
    pub fn is_registered(env: Env, issuer_key_id: U256) -> bool {
        env.storage().persistent().has(&DataKey::IssuerSeen(issuer_key_id))
    }

    /// Next available leaf index (== number of issuers registered so far).
    pub fn next_index(env: Env) -> Result<u32, Error> {
        env.storage().persistent().get(&DataKey::NextIndex).ok_or(Error::NotInitialized)
    }

    /// Tree depth.
    pub fn levels(env: Env) -> Result<u32, Error> {
        env.storage().persistent().get(&DataKey::Levels).ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
