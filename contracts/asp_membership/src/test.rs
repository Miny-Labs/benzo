#![allow(clippy::expect_used)] // tests may .expect() on known-good fixtures
#![cfg(test)]

use super::*;
use core::ops::Add;
use num_bigint::BigUint;
use soroban_sdk::{Address, Bytes, Env, U256, Vec, testutils::Address as _, vec};
use zkhash::{
    ark_ff::{BigInteger, Fp256, PrimeField},
    fields::bn256::FpBN256 as Scalar,
    poseidon2::{poseidon2::Poseidon2, poseidon2_instance_bn256::POSEIDON2_BN256_PARAMS_2},
};

/// Create a test environment that disables snapshot writing under Miri.
/// Miri's isolation mode blocks filesystem operations, which the Soroban SDK
/// uses for test snapshots.
fn test_env() -> Env {
    #[cfg(miri)]
    {
        use soroban_sdk::testutils::EnvTestConfig;
        Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        })
    }
    #[cfg(not(miri))]
    {
        Env::default()
    }
}

#[test]
fn test_init_valid() {
    let env = test_env();
    let admin = Address::generate(&env);
    env.register(ASPMembership, (admin, 3u32));
}

/// This test is skipped under Miri because the panic formatting path triggers
/// undefined behavior in the `ethnum` crate's unsafe formatting code.
/// See: https://github.com/nlordell/ethnum-rs/issues/34
#[test]
#[cfg_attr(miri, ignore)]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_init_invalid_levels_zero() {
    let env = test_env();
    let admin = Address::generate(&env);
    env.register(ASPMembership, (admin, 0u32));
}

/// This test is skipped under Miri because the panic formatting path triggers
/// undefined behavior in the `ethnum` crate's unsafe formatting code.
/// See: https://github.com/nlordell/ethnum-rs/issues/34
#[test]
#[cfg_attr(miri, ignore)]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_init_invalid_levels_too_large() {
    let env = test_env();
    let admin = Address::generate(&env);
    env.register(ASPMembership, (admin, 33u32));
}

#[test]
fn test_constructor_sets_admin_and_levels() {
    let env = test_env();
    let admin = Address::generate(&env);
    let levels = 3u32;
    let contract_id = env.register(ASPMembership, (admin.clone(), levels));

    let stored_admin: Address = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin set in constructor")
    });
    let stored_levels: u32 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Levels)
            .expect("Levels set in constructor")
    });

    assert_eq!(stored_admin, admin);
    assert_eq!(stored_levels, levels);
}

#[test]
fn test_get_root() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin.clone(), 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Get the initial root
    let initial_root = client.get_root();
    let zero = U256::from_u32(&env, 0u32);
    assert_ne!(initial_root, zero, "Initial root should not be zero"); // As we define zero in a different way

    // Verify initial root matches what's in storage
    let stored_root: U256 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Root)
            .expect("Root set in constructor")
    });
    assert_eq!(
        initial_root, stored_root,
        "get_root should match stored root"
    );

    // Insert a leaf and verify root changes
    env.mock_all_auths();
    let leaf = U256::from_u32(&env, 100u32);
    client.insert_leaf(&leaf);

    let new_root = client.get_root();
    assert_ne!(
        new_root, initial_root,
        "Root should change after inserting a leaf"
    );

    // Verify new root also matches storage
    let stored_new_root: U256 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Root)
            .expect("Root set after insert")
    });
    assert_eq!(
        new_root, stored_new_root,
        "get_root should match updated stored root"
    );
}

#[test]
fn test_hash_pair() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Test hash_pair with two U256 values
    let left = U256::from_u32(&env, 1u32);
    let right = U256::from_u32(&env, 2u32);

    let result = client.hash_pair(&left, &right);

    // Verify result is a valid U256 (not zero, since we're hashing non-zero values)
    let zero = U256::from_u32(&env, 0u32);
    assert_ne!(result, zero);

    // Test that hash is deterministic
    let result2 = client.hash_pair(&left, &right);
    assert_eq!(result, result2);

    // Test that different inputs produce different hashes
    let left2 = U256::from_u32(&env, 3u32);
    let result3 = client.hash_pair(&left2, &right);
    assert_ne!(result, result3);
}

#[test]
fn test_insert_leaf() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin.clone(), 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Mock all auths for testing purposes
    env.mock_all_auths();

    // Insert first leaf
    let leaf1 = U256::from_u32(&env, 100u32);
    client.insert_leaf(&leaf1);

    // Insert the second leaf
    let leaf2 = U256::from_u32(&env, 200u32);
    client.insert_leaf(&leaf2);

    // Check NextIndex after both insertions
    let next_index1: u64 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .expect("NextIndex set after insert")
    });
    assert_eq!(next_index1, 2, "NextIndex should be 2 after two insertions");
}

/// This test is skipped under Miri because the panic formatting path triggers
/// undefined behavior in the `ethnum` crate's unsafe formatting code.
/// See: https://github.com/nlordell/ethnum-rs/issues/34
#[test]
#[cfg_attr(miri, ignore)]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_insert_leaf_requires_admin() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Try to insert leaf
    // It should fail as we did not call mock_all_auths()
    let leaf = U256::from_u32(&env, 100u32);
    client.insert_leaf(&leaf);
}

/// This test is skipped under Miri because the panic formatting path triggers
/// undefined behavior in the `ethnum` crate's unsafe formatting code.
/// See: https://github.com/nlordell/ethnum-rs/issues/34
#[test]
#[cfg_attr(miri, ignore)]
#[should_panic]
fn test_insert_leaf_merkle_tree_full() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin.clone(), 2u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Mock all auths for testing purposes
    env.mock_all_auths();

    // Insert 4 leaves
    for i in 0u32..4 {
        let leaf = U256::from_u32(&env, i + 1);
        client.insert_leaf(&leaf);
    }

    // Try to insert one more leaf, which should fail as the tree is full
    let leaf5 = U256::from_u32(&env, 5u32);
    client.insert_leaf(&leaf5);
}

#[test]
fn test_update_admin() {
    let env = test_env();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin.clone(), 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Verify admin was set correctly
    let stored_admin: Address = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin set in constructor")
    });
    assert_eq!(stored_admin, admin);

    // Update admin (using mock_all_auths to authorize the update)
    env.mock_all_auths();
    client.update_admin(&new_admin);

    // Verify admin was updated in storage
    let stored_admin_after: Address = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin updated")
    });
    assert_eq!(stored_admin_after, new_admin);
}

#[test]
fn test_new_admin_can_insert_after_update() {
    let env = test_env();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin.clone(), 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    env.mock_all_auths();
    // Update admin
    client.update_admin(&new_admin);

    // Verify the new admin can insert a leaf (using mock_all_auths to authorize)

    let leaf = U256::from_u32(&env, 100u32);
    client.insert_leaf(&leaf);

    // Verify the insertion succeeded
    let next_index: u64 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .expect("NextIndex set after insert")
    });
    assert_eq!(
        next_index, 1,
        "NextIndex should be 1 after insertion by new admin"
    );
}

#[test]
fn test_multiple_insertions() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin.clone(), 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    env.mock_all_auths();

    // Insert 5 leaves
    for i in 0u32..5 {
        let leaf = U256::from_u32(&env, (i + 1) * 100u32);
        client.insert_leaf(&leaf);
    }

    // Verify NextIndex was updated correctly
    let next_index: u64 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .expect("NextIndex set after inserts")
    });
    assert_eq!(
        next_index, 5,
        "NextIndex should be 5 after inserting 5 leaves"
    );
}

#[test]
fn test_admin_insert_only_defaults_to_true() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));

    let stored: bool = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::AdminInsertOnly)
            .expect("AdminInsertOnly set in constructor")
    });
    assert!(stored, "AdminInsertOnly should default to true");
}

#[test]
fn test_set_admin_insert_only() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    env.mock_all_auths();

    // Disable admin-only insert
    client.set_admin_insert_only(&false);

    let stored: bool = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::AdminInsertOnly)
            .expect("AdminInsertOnly updated")
    });
    assert!(!stored, "AdminInsertOnly should be false after setting it");

    // Re-enable admin-only insert
    client.set_admin_insert_only(&true);

    let stored: bool = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::AdminInsertOnly)
            .expect("AdminInsertOnly re-enabled")
    });
    assert!(stored, "AdminInsertOnly should be true after re-enabling");
}

/// This test is skipped under Miri because the panic formatting path triggers
/// undefined behavior in the `ethnum` crate's unsafe formatting code.
/// See: https://github.com/nlordell/ethnum-rs/issues/34
#[test]
#[cfg_attr(miri, ignore)]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_set_admin_insert_only_requires_admin() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Should fail without mock_all_auths
    client.set_admin_insert_only(&false);
}

#[test]
fn test_insert_leaf_without_admin_when_permissionless() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Admin disables admin-only insert via direct storage manipulation
    // to avoid needing mock_all_auths (which would mask the auth check
    // we're trying to verify is skipped).
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::AdminInsertOnly, &false);
    });

    // Insert a leaf WITHOUT mock_all_auths — should succeed because
    // admin_insert_only is false
    let leaf = U256::from_u32(&env, 42u32);
    client.insert_leaf(&leaf);

    let next_index: u64 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .expect("NextIndex set after insert")
    });
    assert_eq!(next_index, 1, "Leaf should be inserted without admin auth");
}

/// This test is skipped under Miri because the panic formatting path triggers
/// undefined behavior in the `ethnum` crate's unsafe formatting code.
/// See: https://github.com/nlordell/ethnum-rs/issues/34
#[test]
#[cfg_attr(miri, ignore)]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_insert_leaf_requires_admin_when_re_enabled() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Disable admin-only insert via storage so we don't need mock_all_auths
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::AdminInsertOnly, &false);
    });

    // Insert a leaf permissionlessly (should succeed)
    let leaf1 = U256::from_u32(&env, 100u32);
    client.insert_leaf(&leaf1);

    // Re-enable admin-only insert via storage
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::AdminInsertOnly, &true);
    });

    // This should panic — admin auth is required again and no auths are mocked
    let leaf2 = U256::from_u32(&env, 200u32);
    client.insert_leaf(&leaf2);
}

#[test]
fn test_permissionless_insert_multiple_leaves() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.set_admin_insert_only(&false);

    // Insert multiple leaves
    for i in 0..5 {
        let leaf = U256::from_u32(&env, (i + 1) * 10u32);
        client.insert_leaf(&leaf);
    }

    let next_index: u64 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .expect("NextIndex set after inserts")
    });
    assert_eq!(
        next_index, 5,
        "Should have 5 leaves after permissionless insertions"
    );
}

#[test]
fn test_permissionless_insert_updates_root() {
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.set_admin_insert_only(&false);

    let root_before = client.get_root();

    let leaf = U256::from_u32(&env, 42u32);
    client.insert_leaf(&leaf);

    let root_after = client.get_root();
    assert_ne!(
        root_before, root_after,
        "Root should change after permissionless insert"
    );
}

/// Poseidon2 compression function (same as in
/// circuits/src/test/utils/general.rs)
fn poseidon2_compression(left: Scalar, right: Scalar) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_2);
    let mut perm = h.permutation(&[left, right]);
    perm[0] = perm[0].add(left);
    perm[1] = perm[1].add(right);
    perm[0] // By default, we truncate to one element
}

/// Convert Soroban U256 to off-chain Scalar FpBN256
fn u256_to_scalar(_env: &Env, u256: &U256) -> Scalar {
    // Convert U256 to bytes (big-endian)
    let bytes: Bytes = u256.to_be_bytes();
    let mut bytes_array = [0u8; 32];
    bytes.copy_into_slice(&mut bytes_array);

    // Convert bytes to BigUint
    let biguint = BigUint::from_bytes_be(&bytes_array);

    // Convert BigUint to FpBN256
    Fp256::from(biguint)
}

#[test]
fn test_hash_pair_consistency_1() {
    // Verify that hash_pair on-chain matches poseidon2_compression off-chain
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    // Test on-chain hash
    let left_u256 = U256::from_u32(&env, 1234u32);
    let right_u256 = U256::from_u32(&env, 6789u32);
    let on_chain_hash = client.hash_pair(&left_u256, &right_u256);

    // Test off-chain hash
    let off_chain_hash = poseidon2_compression(Scalar::from(1234u32), Scalar::from(6789u32));
    let bytes_offchain = off_chain_hash.into_bigint().to_bytes_be();
    let bytes_on_chain = on_chain_hash.to_be_bytes();

    // They should match
    for (i, item) in bytes_offchain.iter().enumerate().take(32) {
        assert_eq!(
            *item,
            bytes_on_chain
                .get(u32::try_from(i).expect("index fits in u32"))
                .expect("byte exists at index"),
            "hash_pair compression on-chain should match poseidon2_compression off-chain"
        );
    }
}

#[test]
fn test_hash_pair_consistency_2() {
    // Verify that hash_pair on-chain matches poseidon2_compression off-chain
    let env = test_env();
    let admin = Address::generate(&env);
    let contract_id = env.register(ASPMembership, (admin, 3u32));
    let client = ASPMembershipClient::new(&env, &contract_id);

    let a_bytes = [
        38, 87, 116, 229, 180, 73, 149, 93, 95, 216, 55, 138, 202, 129, 16, 169, 208, 107, 174, 63,
        131, 35, 230, 172, 229, 181, 244, 209, 137, 98, 89, 216,
    ];
    let b_bytes = [
        33, 244, 234, 36, 146, 173, 224, 6, 168, 238, 127, 183, 100, 6, 10, 149, 164, 238, 245,
        202, 147, 30, 3, 123, 205, 240, 95, 194, 128, 103, 208, 8,
    ];
    // Test on-chain hash
    let left_u256 = U256::from_be_bytes(&env, &Bytes::from_array(&env, &a_bytes));
    let right_u256 = U256::from_be_bytes(&env, &Bytes::from_array(&env, &b_bytes));
    let on_chain_hash = client.hash_pair(&left_u256, &right_u256);

    // Test off-chain hash
    let off_chain_hash = poseidon2_compression(
        u256_to_scalar(&env, &left_u256),
        u256_to_scalar(&env, &right_u256),
    );
    let bytes_offchain = off_chain_hash.into_bigint().to_bytes_be();
    let bytes_on_chain = on_chain_hash.to_be_bytes();

    // They should match
    for (i, item) in bytes_offchain.iter().enumerate().take(32) {
        assert_eq!(
            *item,
            bytes_on_chain
                .get(u32::try_from(i).expect("index fits in u32"))
                .expect("byte exists at index"),
            "hash_pair compression on-chain should match poseidon2_compression off-chain"
        );
    }
}

#[test]
fn test_merkle_consistency() {
    let env = test_env();
    let admin = Address::generate(&env);
    // Initialize with 2 levels (4 leaves)
    let levels = 2u32;
    let contract_id = env.register(ASPMembership, (admin, levels));
    let client = ASPMembershipClient::new(&env, &contract_id);
    let num_leaves = 1u32 << levels;

    // Mock all auths for testing
    env.mock_all_auths();

    // Precomputed expected state off-chain
    // These were pre-computed to remove any std dependency in the test
    let off_chain_roots: Vec<U256> = vec![
        &env,
        U256::from_be_bytes(
            &env,
            &Bytes::from_array(
                &env,
                &[
                    14, 191, 180, 210, 240, 91, 182, 164, 115, 201, 191, 247, 37, 134, 254, 200, 6,
                    241, 172, 35, 112, 21, 197, 112, 215, 199, 130, 73, 207, 125, 119, 64,
                ],
            ),
        ), //empty tree
        U256::from_be_bytes(
            &env,
            &Bytes::from_array(
                &env,
                &[
                    2, 120, 28, 13, 110, 36, 206, 135, 94, 188, 115, 139, 73, 49, 6, 70, 96, 170,
                    230, 104, 63, 121, 109, 180, 247, 21, 224, 124, 162, 43, 81, 226,
                ],
            ),
        ), // 1 leaf added
        U256::from_be_bytes(
            &env,
            &Bytes::from_array(
                &env,
                &[
                    35, 47, 88, 177, 89, 72, 81, 64, 42, 108, 133, 103, 90, 175, 228, 78, 125, 225,
                    236, 43, 45, 75, 137, 233, 157, 170, 59, 210, 133, 19, 9, 22,
                ],
            ),
        ), // and so on.
        U256::from_be_bytes(
            &env,
            &Bytes::from_array(
                &env,
                &[
                    20, 99, 15, 109, 230, 120, 0, 242, 185, 15, 101, 119, 246, 133, 191, 209, 130,
                    200, 88, 195, 93, 67, 169, 4, 191, 181, 247, 8, 79, 181, 177, 115,
                ],
            ),
        ),
        U256::from_be_bytes(
            &env,
            &Bytes::from_array(
                &env,
                &[
                    23, 225, 197, 156, 139, 142, 232, 34, 202, 96, 195, 138, 141, 144, 133, 159,
                    77, 162, 48, 234, 115, 60, 82, 8, 161, 113, 175, 199, 85, 247, 46, 82,
                ],
            ),
        ),
    ];

    // Get the on-chain root
    let on_chain_root: U256 = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Root)
            .expect("Root set in constructor")
    });

    // Empty roots should match
    assert_eq!(
        on_chain_root,
        off_chain_roots
            .get(0)
            .expect("off_chain_roots has element 0")
    );

    // Insert all leaves on-chain
    for i in 0..num_leaves {
        let leaf = U256::from_u32(&env, (i + 1) * 100u32);
        client.insert_leaf(&leaf);

        // Get the on-chain root
        let on_chain_root: U256 = env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .get(&DataKey::Root)
                .expect("Root updated after insert")
        });

        // Enforce roots match after inserting a leaf
        assert_eq!(
            on_chain_root,
            off_chain_roots
                .get(i + 1)
                .expect("off_chain_roots has element")
        );
    }
}

// ---- proof-gated admission (admit_by_proof) ----
//
// Uses an arkworks free-inputs circuit (same pattern as the pool test) to mint a
// real Groth16 proof, registers it against the verifier, and exercises the
// proof-gated allow-set admission end-to-end.
mod admit {
    extern crate std;
    use super::*;
    use ark_bn254::{Bn254, Fr as ArkFr};
    use ark_ff::{Field, PrimeField};
    use ark_groth16::{Groth16, ProvingKey};
    use ark_relations::gr1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
    use ark_snark::SNARK;
    use ark_std::rand::{SeedableRng, rngs::StdRng};
    use contract_types::Groth16Proof;
    use soroban_sdk::{
        BytesN, Symbol,
        crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    };
    use soroban_utils::{g1_bytes_from_ark, g2_bytes_from_ark, vk_bytes_from_ark};
    use std::vec::Vec as StdVec;

    struct FreeInputs<F: Field> {
        inputs: StdVec<F>,
    }
    impl<F: Field> ConstraintSynthesizer<F> for FreeInputs<F> {
        fn generate_constraints(self, cs: ConstraintSystemRef<F>) -> Result<(), SynthesisError> {
            let mut vars = StdVec::new();
            for v in &self.inputs {
                let v = *v;
                vars.push(cs.new_input_variable(|| Ok(v))?);
            }
            let w = cs.new_witness_variable(|| Ok(self.inputs[0]))?;
            cs.enforce_r1cs_constraint(
                || w.into(),
                || ark_relations::gr1cs::Variable::One.into(),
                || vars[0].into(),
            )?;
            Ok(())
        }
    }

    fn fr_from_u256(value: &U256) -> ArkFr {
        let mut buf = [0u8; 32];
        value.to_be_bytes().copy_into_slice(&mut buf);
        ArkFr::from_be_bytes_mod_order(&buf)
    }

    fn prove(env: &Env, pk: &ProvingKey<Bn254>, publics: &[U256]) -> Groth16Proof {
        let mut rng = StdRng::seed_from_u64(99);
        let inputs: StdVec<ArkFr> = publics.iter().map(fr_from_u256).collect();
        let proof = Groth16::<Bn254>::prove(pk, FreeInputs { inputs }, &mut rng).expect("prove");
        Groth16Proof {
            a: Bn254G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.a))),
            b: Bn254G2Affine::from_bytes(BytesN::from_array(env, &g2_bytes_from_ark(proof.b))),
            c: Bn254G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.c))),
        }
    }

    fn fr_pubs(env: &Env, publics: &[U256]) -> Vec<Bn254Fr> {
        let mut v = Vec::new(env);
        for p in publics {
            let mut buf = [0u8; 32];
            p.to_be_bytes().copy_into_slice(&mut buf);
            v.push_back(Bn254Fr::from_bytes(BytesN::from_array(env, &buf)));
        }
        v
    }

    fn setup() -> (Env, ASPMembershipClient<'static>, ProvingKey<Bn254>) {
        let env = test_env();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let asp_id = env.register(ASPMembership, (admin.clone(), 16u32));
        let asp = ASPMembershipClient::new(&env, &asp_id);
        // Verifier holding a 7-input KYC vk (kyc_credential has 7 public inputs).
        let verifier_id = env.register(benzo_verifier_groth16::BenzoVerifier, (admin.clone(),));
        let verifier = benzo_verifier_groth16::BenzoVerifierClient::new(&env, &verifier_id);
        let mut rng = StdRng::seed_from_u64(7);
        let circuit = FreeInputs {
            inputs: std::vec![ArkFr::from(1u64); 7],
        };
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng).expect("setup");
        verifier.set_vk(&Symbol::new(&env, "KYC"), &vk_bytes_from_ark(&env, &vk));
        asp.set_kyc_verifier(&verifier_id, &Symbol::new(&env, "KYC"));
        (env, asp, pk)
    }

    // kyc_credential public order: [issuerRegistryRoot, credType, currentTime,
    // scope, identityNullifier, addressBinding, admitLeaf]; admitLeaf is index 6.
    fn kyc_publics(env: &Env, admit_leaf: &U256) -> [U256; 7] {
        [
            U256::from_u32(env, 1),
            U256::from_u32(env, 0),
            U256::from_u32(env, 100),
            U256::from_u32(env, 42),
            U256::from_u32(env, 555),
            U256::from_u32(env, 666),
            admit_leaf.clone(),
        ]
    }

    #[test]
    fn admit_by_valid_kyc_proof_inserts_leaf() {
        let (env, asp, pk) = setup();
        let admit_leaf = U256::from_u32(&env, 778_899);
        let publics = kyc_publics(&env, &admit_leaf);
        let root_before = asp.get_root();
        let proof = prove(&env, &pk, &publics);
        // The proof IS the authorization — no admin insert. credType (tier) = 0.
        asp.admit_by_proof(&proof, &fr_pubs(&env, &publics), &admit_leaf, &0u32, &U256::from_u32(&env, 1));
        assert_ne!(asp.get_root(), root_before, "a valid credential must admit the leaf");
    }

    #[test]
    fn admit_rejects_leaf_not_matching_the_proof() {
        let (env, asp, pk) = setup();
        let admit_leaf = U256::from_u32(&env, 778_899);
        let publics = kyc_publics(&env, &admit_leaf);
        let proof = prove(&env, &pk, &publics);
        // Submit a DIFFERENT leaf than public input #6 — must be rejected so an
        // attacker can't admit an arbitrary leaf behind a valid proof.
        let res = asp.try_admit_by_proof(
            &proof,
            &fr_pubs(&env, &publics),
            &U256::from_u32(&env, 111_111),
            &0u32,
            &U256::from_u32(&env, 1),
        );
        assert!(res.is_err(), "leaf != public input #6 must be rejected");
    }

    #[test]
    fn admit_rejects_a_tampered_proof() {
        let (env, asp, pk) = setup();
        let admit_leaf = U256::from_u32(&env, 778_899);
        let publics = kyc_publics(&env, &admit_leaf);
        let proof = prove(&env, &pk, &publics);
        // Verify against DIFFERENT public inputs than the proof was made for.
        let mut wrong = publics;
        wrong[0] = U256::from_u32(&env, 999);
        let res = asp.try_admit_by_proof(&proof, &fr_pubs(&env, &wrong), &admit_leaf, &0u32, &U256::from_u32(&env, 999));
        assert!(res.is_err(), "a non-verifying proof must not admit");
    }

    // kyc_publics with a chosen assurance tier (credType, public input #1).
    fn kyc_publics_tier(env: &Env, admit_leaf: &U256, tier: u32) -> [U256; 7] {
        [
            U256::from_u32(env, 1),
            U256::from_u32(env, tier),
            U256::from_u32(env, 100),
            U256::from_u32(env, 42),
            U256::from_u32(env, 555),
            U256::from_u32(env, 666),
            admit_leaf.clone(),
        ]
    }

    #[test]
    fn admit_enforces_minimum_tier() {
        let (env, asp, pk) = setup();
        asp.set_min_tier(&2); // corridor requires VERIFIED_ID (tier 2)
        let admit_leaf = U256::from_u32(&env, 778_899);

        // A tier-1 credential is rejected (below the required minimum).
        let p1 = kyc_publics_tier(&env, &admit_leaf, 1);
        let proof1 = prove(&env, &pk, &p1);
        let res = asp.try_admit_by_proof(&proof1, &fr_pubs(&env, &p1), &admit_leaf, &1u32, &U256::from_u32(&env, 1));
        assert!(res.is_err(), "tier 1 < required tier 2 must be rejected");

        // A tier-2 credential admits.
        let p2 = kyc_publics_tier(&env, &admit_leaf, 2);
        let proof2 = prove(&env, &pk, &p2);
        let root_before = asp.get_root();
        asp.admit_by_proof(&proof2, &fr_pubs(&env, &p2), &admit_leaf, &2u32, &U256::from_u32(&env, 1));
        assert_ne!(asp.get_root(), root_before, "tier 2 >= required tier 2 must admit");
    }

    #[test]
    fn admit_rejects_claimed_tier_not_matching_proof() {
        let (env, asp, _pk) = setup();
        let admit_leaf = U256::from_u32(&env, 778_899);
        let p = kyc_publics_tier(&env, &admit_leaf, 1); // credential proves tier 1
        let proof = prove(&env, &_pk, &p);
        // Caller claims tier 3 but the proof only attests tier 1 → bound, rejected.
        let res = asp.try_admit_by_proof(&proof, &fr_pubs(&env, &p), &admit_leaf, &3u32, &U256::from_u32(&env, 1));
        assert!(res.is_err(), "claimed tier must match the credential's credType");
    }
}
