#![no_std]

//! Benzo incremental Merkle tree with root history.
//!
//! An append-only, fixed-depth binary Merkle tree over the BN254 scalar
//! field. Nodes are hashed with the Poseidon2 compression host function
//! (CAP-0075) using the parameterization pinned in `soroban-utils` — the
//! byte-identical twin of the circuit's `PoseidonCompress` template.
//!
//! The contract persists only the right-frontier (`FilledSubtree(level)`),
//! the `NextIndex`, and a ring buffer of the last [`ROOT_HISTORY_SIZE`]
//! roots, so an insert costs O(depth) host hashes and proofs built against
//! a slightly stale root still verify. All state is **persistent** storage.
//!
//! Writes are gated to the configured `operator` (the Benzo pool contract).

use soroban_sdk::{
    Address, Env, U256, Vec, contract, contracterror, contractevent, contractimpl, contracttype,
};
use soroban_utils::{get_zeroes, poseidon2_compress};

/// Number of recent roots accepted on spend (canonical ROOT_HISTORY = 128).
pub const ROOT_HISTORY_SIZE: u32 = 128;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this operation
    NotAuthorized = 1,
    /// Merkle tree has reached maximum capacity
    MerkleTreeFull = 2,
    /// Invalid Merkle tree levels configuration (must be 1..=32)
    WrongLevels = 3,
    /// Contract is not initialized
    NotInitialized = 4,
    /// Arithmetic overflow occurred
    Overflow = 5,
}

/// Storage keys for the tree state (all persistent).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    /// Administrator (may set the operator)
    Admin,
    /// Operator (pool) allowed to insert leaves
    Operator,
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
    /// Membership index for the ring buffer (root -> present), so
    /// `is_known_root` is a single O(1) storage probe instead of a scan
    /// that would blow the per-tx ledger-entry footprint limit.
    KnownRoot(U256),
}

/// Emitted on every insert so indexers can mirror the tree.
#[contractevent]
#[derive(Clone)]
pub struct LeafInsertedEvent {
    /// The leaf value (note commitment)
    #[topic]
    pub leaf: U256,
    /// Index position in the tree
    pub index: u32,
    /// New Merkle root after insertion
    pub root: U256,
}

#[contract]
pub struct BenzoMerkleTree;

#[contractimpl]
impl BenzoMerkleTree {
    /// Initialize the tree.
    ///
    /// * `admin` — may set the operator (the pool address, known post-deploy).
    /// * `levels` — tree depth (1..=32; Benzo canonical default is 32).
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

    /// Set the operator (the pool contract). Admin-only.
    pub fn set_operator(env: Env, operator: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Operator, &operator);
        Ok(())
    }

    /// Insert a single leaf; returns its index. Operator-only.
    pub fn insert_leaf(env: Env, leaf: U256) -> Result<u32, Error> {
        let operator: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Operator)
            .ok_or(Error::NotInitialized)?;
        operator.require_auth();

        let storage = env.storage().persistent();
        let levels: u32 = storage
            .get(&DataKey::Levels)
            .ok_or(Error::NotInitialized)?;
        let next_index: u32 = storage
            .get(&DataKey::NextIndex)
            .ok_or(Error::NotInitialized)?;

        let max_leaves = 1u64
            .checked_shl(levels)
            .ok_or(Error::WrongLevels)?;
        if u64::from(next_index) >= max_leaves {
            return Err(Error::MerkleTreeFull);
        }

        // Classic incremental-tree update along the path to the root.
        let mut current_hash = leaf.clone();
        let mut current_index = next_index;
        for lvl in 0..levels {
            if current_index & 1 == 0 {
                // Left child: cache it on the frontier, pair with the zero.
                storage.set(&DataKey::FilledSubtree(lvl), &current_hash);
                let zero: U256 = storage
                    .get(&DataKey::Zeroes(lvl))
                    .ok_or(Error::NotInitialized)?;
                current_hash = poseidon2_compress(&env, current_hash, zero);
            } else {
                // Right child: pair with the cached left sibling.
                let left: U256 = storage
                    .get(&DataKey::FilledSubtree(lvl))
                    .ok_or(Error::NotInitialized)?;
                current_hash = poseidon2_compress(&env, left, current_hash);
            }
            current_index >>= 1;
        }

        let root_index: u32 = storage
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        let new_root_index = root_index
            .checked_add(1)
            .ok_or(Error::Overflow)?
            % ROOT_HISTORY_SIZE;
        // Evict the root that previously occupied this ring slot.
        if let Some(evicted) = storage.get::<DataKey, U256>(&DataKey::Root(new_root_index)) {
            storage.remove(&DataKey::KnownRoot(evicted));
        }
        storage.set(&DataKey::Root(new_root_index), &current_hash);
        storage.set(&DataKey::KnownRoot(current_hash.clone()), &true);
        storage.set(&DataKey::CurrentRootIndex, &new_root_index);
        storage.set(
            &DataKey::NextIndex,
            &(next_index.checked_add(1).ok_or(Error::Overflow)?),
        );

        LeafInsertedEvent {
            leaf,
            index: next_index,
            root: current_hash,
        }
        .publish(&env);

        Ok(next_index)
    }

    /// Current (most recent) Merkle root.
    pub fn current_root(env: Env) -> Result<U256, Error> {
        let storage = env.storage().persistent();
        let idx: u32 = storage
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        storage.get(&DataKey::Root(idx)).ok_or(Error::NotInitialized)
    }

    /// True if `root` is in the recent-root ring buffer (zero is never valid).
    /// O(1): a single presence probe on the `KnownRoot` index.
    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        if root == U256::from_u32(&env, 0) {
            return Ok(false);
        }
        Ok(env
            .storage()
            .persistent()
            .has(&DataKey::KnownRoot(root)))
    }

    /// Next available leaf index (== number of leaves inserted so far).
    pub fn next_index(env: Env) -> Result<u32, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .ok_or(Error::NotInitialized)
    }

    /// Tree depth.
    pub fn levels(env: Env) -> Result<u32, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Levels)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
