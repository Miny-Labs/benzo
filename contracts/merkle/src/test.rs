#![allow(clippy::expect_used)] // tests may .expect() on known-good fixtures

use super::*;
use core::ops::Add;
use soroban_sdk::{Address, Bytes, Env, U256, testutils::Address as _};
use zkhash::{
    ark_ff::{BigInteger, PrimeField},
    fields::bn256::FpBN256 as Scalar,
    poseidon2::{poseidon2::Poseidon2, poseidon2_instance_bn256::POSEIDON2_BN256_PARAMS_2},
};

extern crate std;
use std::vec::Vec as StdVec;

/// Off-chain Poseidon2 compression mirror (zkhash reference implementation;
/// must stay byte-identical to the CAP-0075 host-function parameterization).
fn poseidon2_compression(left: Scalar, right: Scalar) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_2);
    let perm = h.permutation(&[left, right]);
    perm[0].add(left)
}

fn u256_to_scalar(_env: &Env, v: &U256) -> Scalar {
    let mut buf = [0u8; 32];
    v.to_be_bytes().copy_into_slice(&mut buf);
    Scalar::from_be_bytes_mod_order(&buf)
}

fn scalar_to_u256(env: &Env, s: &Scalar) -> U256 {
    let bytes = s.into_bigint().to_bytes_be();
    let mut buf = [0u8; 32];
    buf[32 - bytes.len()..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &Bytes::from_array(env, &buf))
}

fn setup(levels: u32) -> (Env, Address, Address, BenzoMerkleTreeClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let contract_id = env.register(BenzoMerkleTree, (admin, levels));
    let client = BenzoMerkleTreeClient::new(&env, &contract_id);
    client.set_operator(&operator);
    (env, operator, contract_id, client)
}

#[test]
fn init_and_initial_root_nonzero() {
    let (env, _op, _id, client) = setup(8);
    let root = client.current_root();
    assert_ne!(root, U256::from_u32(&env, 0));
    assert_eq!(client.next_index(), 0u32);
    assert_eq!(client.levels(), 8u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn init_rejects_zero_levels() {
    let env = Env::default();
    let admin = Address::generate(&env);
    env.register(BenzoMerkleTree, (admin, 0u32));
}

#[test]
fn insert_updates_root_and_history() {
    let (env, _op, _id, client) = setup(8);
    let root0 = client.current_root();

    let idx = client.insert_leaf(&U256::from_u32(&env, 100));
    assert_eq!(idx, 0u32);
    let root1 = client.current_root();
    assert_ne!(root1, root0);

    let idx2 = client.insert_leaf(&U256::from_u32(&env, 200));
    assert_eq!(idx2, 1u32);
    let root2 = client.current_root();

    // Both historical roots remain valid (ring buffer).
    assert!(client.is_known_root(&root1));
    assert!(client.is_known_root(&root2));
    assert!(client.is_known_root(&root0));
    // Zero and garbage roots are not.
    assert!(!client.is_known_root(&U256::from_u32(&env, 0)));
    assert!(!client.is_known_root(&U256::from_u32(&env, 12345)));
}

/// Byte-identity test: the on-chain root (Poseidon2 host function) must match
/// an off-chain reconstruction of the same tree using the zkhash reference
/// Poseidon2 — the same implementation our circuits and SDK pin.
#[test]
fn onchain_root_matches_offchain_zkhash_mirror() {
    let levels = 6u32;
    let (env, _op, contract_id, client) = setup(levels);

    // Read the contract's pinned zero table.
    let zeroes: StdVec<U256> = (0..=levels)
        .map(|i| {
            env.as_contract(&contract_id, || {
                env.storage()
                    .persistent()
                    .get(&DataKey::Zeroes(i))
                    .expect("zeroes set in constructor")
            })
        })
        .collect();

    let leaves: StdVec<u32> = std::vec![111, 222, 333, 444, 555];
    for leaf in &leaves {
        client.insert_leaf(&U256::from_u32(&env, *leaf));
    }
    let onchain_root = client.current_root();

    // Off-chain full reconstruction with zkhash.
    let mut level_nodes: StdVec<Scalar> = leaves
        .iter()
        .map(|l| Scalar::from(u64::from(*l)))
        .collect();
    for lvl in 0..levels {
        let zero = u256_to_scalar(&env, &zeroes[lvl as usize]);
        let mut next: StdVec<Scalar> = StdVec::new();
        let mut i = 0;
        while i < level_nodes.len() {
            let left = level_nodes[i];
            let right = if i + 1 < level_nodes.len() {
                level_nodes[i + 1]
            } else {
                zero
            };
            next.push(poseidon2_compression(left, right));
            i += 2;
        }
        if next.is_empty() {
            next.push(poseidon2_compression(zero, zero));
        }
        level_nodes = next;
    }
    let offchain_root = scalar_to_u256(&env, &level_nodes[0]);

    assert_eq!(
        onchain_root, offchain_root,
        "on-chain Poseidon2 host hashing must match the zkhash reference mirror"
    );
}

/// Fuzz: for many pseudo-random leaf sets, the on-chain incremental root must
/// equal a full off-chain recomputation with the zkhash reference Poseidon2 —
/// the byte-identity invariant under arbitrary inputs.
#[test]
fn fuzz_onchain_root_matches_offchain() {
    let levels = 5u32;
    let mut x: u64 = 0xDEAD_BEEF_CAFE_F00D;
    for trial in 0..6u32 {
        let (env, _op, contract_id, client) = setup(levels);
        let zeroes: StdVec<U256> = (0..=levels)
            .map(|i| {
                env.as_contract(&contract_id, || {
                    env.storage()
                        .persistent()
                        .get(&DataKey::Zeroes(i))
                        .expect("zeroes")
                })
            })
            .collect();

        let n = 1 + (trial % (1 << levels));
        let mut leaves: StdVec<Scalar> = StdVec::new();
        for _ in 0..n {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            client.insert_leaf(&U256::from_u32(&env, (x % 1_000_000) as u32));
            leaves.push(Scalar::from(x % 1_000_000));
        }
        let onchain = client.current_root();

        let mut nodes = leaves.clone();
        for lvl in 0..levels {
            let zero = u256_to_scalar(&env, &zeroes[lvl as usize]);
            let mut next: StdVec<Scalar> = StdVec::new();
            let mut i = 0;
            while i < nodes.len() {
                let l = nodes[i];
                let r = if i + 1 < nodes.len() { nodes[i + 1] } else { zero };
                next.push(poseidon2_compression(l, r));
                i += 2;
            }
            if next.is_empty() {
                next.push(poseidon2_compression(zero, zero));
            }
            nodes = next;
        }
        assert_eq!(onchain, scalar_to_u256(&env, &nodes[0]), "trial {trial}");
    }
}

#[test]
fn tree_full_rejects_insert() {
    let (env, _op, _id, client) = setup(1);
    client.insert_leaf(&U256::from_u32(&env, 1));
    client.insert_leaf(&U256::from_u32(&env, 2));
    let res = client.try_insert_leaf(&U256::from_u32(&env, 3));
    assert_eq!(res, Err(Ok(Error::MerkleTreeFull)));
}

/// Negative auth: `insert_leaf` is operator-only — must fail without auth.
#[test]
fn insert_leaf_requires_operator_auth() {
    let (env, _op, _id, client) = setup(8);
    env.mock_auths(&[]); // revoke the blanket auth from setup
    let res = client.try_insert_leaf(&U256::from_u32(&env, 123));
    assert!(res.is_err(), "insert_leaf without operator auth must fail");
}

#[test]
fn duplicate_leaf_rejected() {
    // A replayed/duplicate commitment must not take a second leaf slot
    // (preserves the scanner's leaf->index injectivity assumption).
    let (env, _op, _id, client) = setup(8);
    client.insert_leaf(&U256::from_u32(&env, 777));
    let dup = client.try_insert_leaf(&U256::from_u32(&env, 777));
    assert_eq!(dup, Err(Ok(Error::DuplicateLeaf)));
    // A distinct leaf still inserts at the next index.
    assert_eq!(client.insert_leaf(&U256::from_u32(&env, 778)), 1u32);
}

#[test]
fn insert_leaves_matches_sequential_inserts() {
    // Correctness ORACLE for the subtree-merge: batch root + next_index must
    // EXACTLY equal N single inserts, after every chunk. Not a cost test — a
    // depth-32 batch's Poseidon hashing exceeds the mainnet per-tx limit (the
    // hash count is the second half of the cap; storage I/O is the first).
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);
    let op = Address::generate(&env);
    let batch_id = env.register(BenzoMerkleTree, (admin.clone(), 32u32));
    let batch = BenzoMerkleTreeClient::new(&env, &batch_id);
    batch.set_operator(&op);
    let seq_id = env.register(BenzoMerkleTree, (admin, 32u32));
    let seq = BenzoMerkleTreeClient::new(&env, &seq_id);
    seq.set_operator(&op);

    // Chunk sizes exercise many start-index alignments (odd/even start, N=1, 2,
    // odd, power-of-2) — the frontier-boundary handling depends on next_index
    // parity, so this catches off-by-one bugs in the merge. Starts hit by these
    // chunks: 0, 1, 2, 4, 7, 11, 12, 17.
    let chunks: [u32; 8] = [1, 1, 2, 3, 4, 1, 5, 8];
    let mut val: u32 = 1;
    for &c in chunks.iter() {
        let mut leaves: soroban_sdk::Vec<U256> = soroban_sdk::Vec::new(&env);
        for _ in 0..c {
            leaves.push_back(U256::from_u32(&env, val));
            seq.insert_leaf(&U256::from_u32(&env, val));
            val += 1;
        }
        let indices = batch.insert_leaves(&leaves);
        assert_eq!(indices.len(), c, "returns one index per leaf");
        // After each chunk the two trees must agree EXACTLY.
        assert_eq!(batch.next_index(), seq.next_index(), "next_index after chunk");
        assert_eq!(batch.current_root(), seq.current_root(), "root after chunk");
    }
    assert!(seq.is_known_root(&batch.current_root()));
}

#[test]
fn insert_leaves_rejects_intra_batch_duplicate() {
    // A commitment repeated within one batch must be rejected (it can't take two
    // leaf slots), and nothing is committed.
    let (env, _op, _id, client) = setup(8);
    let mut leaves: soroban_sdk::Vec<U256> = soroban_sdk::Vec::new(&env);
    leaves.push_back(U256::from_u32(&env, 5));
    leaves.push_back(U256::from_u32(&env, 6));
    leaves.push_back(U256::from_u32(&env, 5)); // dup of the first
    let res = client.try_insert_leaves(&leaves);
    assert_eq!(res, Err(Ok(Error::DuplicateLeaf)));
}

#[test]
fn insert_leaves_requires_operator_auth() {
    let (env, _op, _id, client) = setup(8);
    env.mock_auths(&[]);
    let mut leaves: soroban_sdk::Vec<U256> = soroban_sdk::Vec::new(&env);
    leaves.push_back(U256::from_u32(&env, 1));
    assert!(client.try_insert_leaves(&leaves).is_err());
}
