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

soroban_sdk::contractmeta!(key = "binver", val = "0.1.0");
soroban_sdk::contractmeta!(key = "name", val = "benzo-merkle");

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
    /// The leaf (commitment) is already present in the tree
    DuplicateLeaf = 6,
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
    /// Presence index for inserted leaves (commitment -> present), so a
    /// replayed/duplicate commitment is rejected before it can occupy a
    /// second leaf position (which would break the scanner's leaf->index
    /// injectivity assumption). One probe + one entry per insert, matching
    /// the per-entry persistent model used by the nullifier set.
    Leaf(U256),
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

        // Reject a replayed/duplicate commitment before it takes a leaf slot.
        if storage.has(&DataKey::Leaf(leaf.clone())) {
            return Err(Error::DuplicateLeaf);
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
        storage.set(&DataKey::Leaf(leaf.clone()), &true);
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

    /// Insert MANY leaves in one call; returns their indices in order.
    /// Operator-only. The batch unlock for `pool::batch_transfer_org`.
    ///
    /// Produces the EXACT same final root + frontier as calling `insert_leaf` N
    /// times (proven by `insert_leaves_matches_sequential_inserts`), but is two
    /// optimisations cheaper:
    ///  1. STORAGE: reads the right-frontier into memory once and writes it back
    ///     once, and adds only the FINAL root to the ring buffer — footprint
    ///     O(depth + N) instead of O(depth * N).
    ///  2. HASHING: a subtree-merge (combine new leaves into subtrees, hash each
    ///     internal node once) costs ~(N + depth) Poseidon hashes instead of
    ///     N * depth — the dominant CPU cost for a multi-leaf insert.
    /// Skipping the intermediate roots is sound: a batch is atomic, so only the
    /// pre-batch root (already known) and the post-batch root are ever referenced
    /// by a spend proof. Per-leaf events carry the exact index and the post-batch
    /// root. Duplicate leaves (pre-existing or repeated within the batch) are
    /// rejected before any state changes.
    pub fn insert_leaves(env: Env, leaves: Vec<U256>) -> Result<Vec<u32>, Error> {
        let operator: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Operator)
            .ok_or(Error::NotInitialized)?;
        operator.require_auth();

        let n = leaves.len();
        if n == 0 {
            return Ok(Vec::new(&env));
        }
        let storage = env.storage().persistent();
        let levels: u32 = storage
            .get(&DataKey::Levels)
            .ok_or(Error::NotInitialized)?;
        let start_index: u32 = storage
            .get(&DataKey::NextIndex)
            .ok_or(Error::NotInitialized)?;

        let max_leaves = 1u64.checked_shl(levels).ok_or(Error::WrongLevels)?;
        if u64::from(start_index)
            .checked_add(u64::from(n))
            .ok_or(Error::Overflow)?
            > max_leaves
        {
            return Err(Error::MerkleTreeFull);
        }

        // Reject duplicates (pre-existing OR repeated within this batch), mark
        // each leaf present, and collect the level-0 node list.
        let mut nodes: Vec<U256> = Vec::new(&env);
        for k in 0..n {
            let leaf = leaves.get(k).ok_or(Error::NotInitialized)?;
            if storage.has(&DataKey::Leaf(leaf.clone())) {
                return Err(Error::DuplicateLeaf);
            }
            storage.set(&DataKey::Leaf(leaf.clone()), &true);
            nodes.push_back(leaf);
        }

        // Cache the right-frontier + zero hashes in memory (read each once).
        let zeros: Vec<U256> = get_zeroes(&env);
        let mut filled: Vec<U256> = Vec::new(&env);
        for lvl in 0..levels {
            filled.push_back(
                storage
                    .get(&DataKey::FilledSubtree(lvl))
                    .ok_or(Error::NotInitialized)?,
            );
        }

        // Subtree-merge batch append. Instead of recomputing each leaf's full
        // root-path (N * depth Poseidon hashes), combine the new leaves into
        // subtrees level by level, computing each distinct internal node ONCE —
        // ~(N + depth) hashes. `nodes` holds the new node values at the current
        // level; `first` is the position of `nodes[0]` at that level. At each
        // level a leading right child pairs with the existing frontier, interior
        // nodes pair off, and a lone trailing left child pairs with the zero
        // subtree (the spine). The frontier `filled[lvl]` is set to the value at
        // the largest even position among the new nodes — exactly what N
        // sequential inserts leave behind (proven by the equivalence test).
        let mut first = start_index;
        for lvl in 0..levels {
            let zero = zeros.get(lvl).ok_or(Error::WrongLevels)?;
            let len = nodes.len();
            let last_pos = first
                .checked_add(len)
                .ok_or(Error::Overflow)?
                .checked_sub(1)
                .ok_or(Error::Overflow)?;
            let q = last_pos & !1u32; // largest even position <= last_pos
            // Pre-batch left sibling at this level — read BEFORE the update below.
            let old_filled = filled.get(lvl).ok_or(Error::NotInitialized)?;

            let mut parents: Vec<U256> = Vec::new(&env);
            let mut i: u32 = 0;
            if first & 1 == 1 {
                // Leading right child pairs with the existing frontier left sibling.
                parents.push_back(poseidon2_compress(
                    &env,
                    old_filled.clone(),
                    nodes.get(0).ok_or(Error::NotInitialized)?,
                ));
                i = 1;
            }
            while i < len {
                if i == len - 1 {
                    // Lone trailing left child: pair with the empty (zero) subtree.
                    parents.push_back(poseidon2_compress(
                        &env,
                        nodes.get(i).ok_or(Error::NotInitialized)?,
                        zero.clone(),
                    ));
                    i = i.checked_add(1).ok_or(Error::Overflow)?;
                } else {
                    parents.push_back(poseidon2_compress(
                        &env,
                        nodes.get(i).ok_or(Error::NotInitialized)?,
                        nodes
                            .get(i.checked_add(1).ok_or(Error::Overflow)?)
                            .ok_or(Error::NotInitialized)?,
                    ));
                    i = i.checked_add(2).ok_or(Error::Overflow)?;
                }
            }

            // New frontier = value at the largest even position among the new
            // nodes, if any (q >= first); otherwise unchanged.
            if q >= first {
                filled.set(lvl, nodes.get(q - first).ok_or(Error::NotInitialized)?);
            }

            first >>= 1;
            nodes = parents;
        }

        // After `levels` rounds the spine has collapsed to the single new root.
        let last_root: U256 = nodes.get(0).ok_or(Error::NotInitialized)?;

        // Per-leaf events + index list. The index is exact; the event root is the
        // post-batch root (a batch is atomic, so no intermediate root is ever
        // observable on-chain).
        let mut indices: Vec<u32> = Vec::new(&env);
        for k in 0..n {
            let leaf_index = start_index.checked_add(k).ok_or(Error::Overflow)?;
            indices.push_back(leaf_index);
            LeafInsertedEvent {
                leaf: leaves.get(k).ok_or(Error::NotInitialized)?,
                index: leaf_index,
                root: last_root.clone(),
            }
            .publish(&env);
        }

        // Flush the frontier once.
        for lvl in 0..levels {
            storage.set(
                &DataKey::FilledSubtree(lvl),
                &filled.get(lvl).ok_or(Error::NotInitialized)?,
            );
        }
        // Add ONLY the final root to the ring buffer (one churn, not N).
        let root_index: u32 = storage
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        let new_root_index = root_index.checked_add(1).ok_or(Error::Overflow)? % ROOT_HISTORY_SIZE;
        if let Some(evicted) = storage.get::<DataKey, U256>(&DataKey::Root(new_root_index)) {
            storage.remove(&DataKey::KnownRoot(evicted));
        }
        storage.set(&DataKey::Root(new_root_index), &last_root);
        storage.set(&DataKey::KnownRoot(last_root.clone()), &true);
        storage.set(&DataKey::CurrentRootIndex, &new_root_index);
        storage.set(
            &DataKey::NextIndex,
            &start_index.checked_add(n).ok_or(Error::Overflow)?,
        );

        Ok(indices)
    }

    /// Current (most recent) Merkle root.
    pub fn current_root(env: Env) -> Result<U256, Error> {
        let storage = env.storage().persistent();
        let idx: u32 = storage
            .get(&DataKey::CurrentRootIndex)
            .ok_or(Error::NotInitialized)?;
        let root = storage.get(&DataKey::Root(idx)).ok_or(Error::NotInitialized)?;
        // Keep the live root entry from being archived (read on every spend).
        soroban_utils::bump_persistent(&env, &DataKey::Root(idx));
        Ok(root)
    }

    /// True if `root` is in the recent-root ring buffer (zero is never valid).
    /// O(1): a single presence probe on the `KnownRoot` index.
    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        if root == U256::from_u32(&env, 0) {
            return Ok(false);
        }
        let key = DataKey::KnownRoot(root);
        let known = env.storage().persistent().has(&key);
        // Keep an in-window root alive (checked on every spend).
        if known {
            soroban_utils::bump_persistent(&env, &key);
        }
        Ok(known)
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
