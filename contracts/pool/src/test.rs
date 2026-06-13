#![cfg(test)]

//! Pool integration tests.
//!
//! These tests register the *real* verifier, merkle, nullifier-set, ASP and
//! viewkey contracts in the Soroban test host and drive the pool through
//! shield / transfer / withdraw with genuine Groth16 proofs.
//!
//! The circuit used here is a "free inputs" circuit (public inputs are
//! unconstrained except input0 == witness), so the tests exercise every
//! contract-side rule — custody, ASP root pinning, ext-hash binding, replay
//! idempotency, pause, caps — without the production circuits. Constraint-
//! level soundness of the production circuits is covered by the circuit
//! test suite (snarkjs) and the on-chain e2e.

use super::pool::*;
use ark_bn254::{Bn254, Fr as ArkFr};
use ark_ff::{Field, PrimeField};
use ark_groth16::{Groth16, ProvingKey};
use ark_relations::gr1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_snark::SNARK;
use ark_std::rand::{SeedableRng, rngs::StdRng};
use contract_types::Groth16Proof;
use soroban_sdk::{
    Address, Bytes, BytesN, Env, Symbol, U256,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine},
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
};
use soroban_utils::{g1_bytes_from_ark, g2_bytes_from_ark, vk_bytes_from_ark};

extern crate std;
use std::vec::Vec as StdVec;

/// Circuit with `n` public inputs, all free except input0 == witness.
#[derive(Clone)]
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

struct Harness {
    env: Env,
    user: Address,
    pool: BenzoPoolClient<'static>,
    pool_id: Address,
    token: TokenClient<'static>,
    merkle: benzo_merkle::BenzoMerkleTreeClient<'static>,
    nullifiers: benzo_nullifier_set::BenzoNullifierSetClient<'static>,
    asp_membership: asp_membership::ASPMembershipClient<'static>,
    asp_non_membership: asp_non_membership::ASPNonMembershipClient<'static>,
    shield_pk: ProvingKey<Bn254>,
    transfer_pk: ProvingKey<Bn254>,
    unshield_pk: ProvingKey<Bn254>,
}

fn u256_from_u32(env: &Env, v: u32) -> U256 {
    U256::from_u32(env, v)
}

fn fr_from_u256(value: &U256) -> ArkFr {
    let mut buf = [0u8; 32];
    value.to_be_bytes().copy_into_slice(&mut buf);
    ArkFr::from_be_bytes_mod_order(&buf)
}

fn prove(env: &Env, pk: &ProvingKey<Bn254>, publics: &[U256]) -> Groth16Proof {
    let mut rng = StdRng::seed_from_u64(99);
    let inputs: StdVec<ArkFr> = publics.iter().map(fr_from_u256).collect();
    let circuit = FreeInputs { inputs };
    let proof = Groth16::<Bn254>::prove(pk, circuit, &mut rng).expect("prove");
    Groth16Proof {
        a: Bn254G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.a))),
        b: Bn254G2Affine::from_bytes(BytesN::from_array(env, &g2_bytes_from_ark(proof.b))),
        c: Bn254G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.c))),
    }
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    // Token (SAC test contract).
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let token_admin = StellarAssetClient::new(&env, &sac.address());

    // Verifier with three VKs from the free-inputs circuit shapes.
    let verifier_id = env.register(benzo_verifier_groth16::BenzoVerifier, (admin.clone(),));
    let verifier = benzo_verifier_groth16::BenzoVerifierClient::new(&env, &verifier_id);
    let mut rng = StdRng::seed_from_u64(7);
    let mut mk_keys = |n: usize| {
        let circuit = FreeInputs {
            inputs: std::vec![ArkFr::from(1u64); n],
        };
        Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng).expect("setup")
    };
    let (shield_pk, shield_vk) = mk_keys(6);
    let (transfer_pk, transfer_vk) = mk_keys(10);
    let (unshield_pk, unshield_vk) = mk_keys(8);
    verifier.set_vk(
        &Symbol::new(&env, "SHIELD"),
        &vk_bytes_from_ark(&env, &shield_vk),
    );
    verifier.set_vk(
        &Symbol::new(&env, "TRANSFER"),
        &vk_bytes_from_ark(&env, &transfer_vk),
    );
    verifier.set_vk(
        &Symbol::new(&env, "UNSHIELD"),
        &vk_bytes_from_ark(&env, &unshield_vk),
    );

    // Modules.
    let merkle_id = env.register(benzo_merkle::BenzoMerkleTree, (admin.clone(), 16u32));
    let merkle = benzo_merkle::BenzoMerkleTreeClient::new(&env, &merkle_id);
    let ns_id = env.register(benzo_nullifier_set::BenzoNullifierSet, (admin.clone(),));
    let nullifiers = benzo_nullifier_set::BenzoNullifierSetClient::new(&env, &ns_id);
    let aspm_id = env.register(asp_membership::ASPMembership, (admin.clone(), 16u32));
    let asp_membership_c = asp_membership::ASPMembershipClient::new(&env, &aspm_id);
    let aspn_id = env.register(asp_non_membership::ASPNonMembership, (admin.clone(),));
    let asp_non_membership_c = asp_non_membership::ASPNonMembershipClient::new(&env, &aspn_id);
    let vka_id = env.register(benzo_viewkey_anchor::BenzoViewkeyAnchor, (admin.clone(),));
    let vka = benzo_viewkey_anchor::BenzoViewkeyAnchorClient::new(&env, &vka_id);

    // Pool.
    let pool_id = env.register(
        BenzoPool,
        (
            admin.clone(),
            sac.address(),
            verifier_id.clone(),
            merkle_id.clone(),
            ns_id.clone(),
            aspm_id.clone(),
            aspn_id.clone(),
            vka_id.clone(),
            1_000_000_000_i128,
        ),
    );
    let pool = BenzoPoolClient::new(&env, &pool_id);

    // Wire operators to the pool.
    merkle.set_operator(&pool_id);
    nullifiers.set_operator(&pool_id);
    vka.set_operator(&pool_id);

    // Fund the user.
    token_admin.mint(&user, &1_000_000_000);

    Harness {
        env,
        user,
        pool,
        pool_id,
        token,
        merkle,
        nullifiers,
        asp_membership: asp_membership_c,
        asp_non_membership: asp_non_membership_c,
        shield_pk,
        transfer_pk,
        unshield_pk,
    }
}

fn do_shield(h: &Harness, amount: i128, commitment: u32) -> u32 {
    let env = &h.env;
    let commitment = u256_from_u32(env, commitment);
    let mvk_tag = u256_from_u32(env, 777);
    let allow_root = h.asp_membership.get_root();
    let depositor = h.pool.address_scalar(&h.user);
    let asset_id = h.pool.asset_id();
    #[allow(clippy::cast_sign_loss)]
    let publics = [
        commitment.clone(),
        U256::from_u128(env, amount as u128),
        asset_id,
        depositor,
        allow_root.clone(),
        mvk_tag.clone(),
    ];
    let proof = prove(env, &h.shield_pk, &publics);
    h.pool.shield(
        &h.user,
        &amount,
        &commitment,
        &mvk_tag,
        &Bytes::from_array(env, &[1u8; 8]),
        &Bytes::from_array(env, &[2u8; 8]),
        &allow_root,
        &proof,
    )
}

#[test]
fn shield_custodies_tokens_and_inserts_leaf() {
    let h = setup();
    let before_user = h.token.balance(&h.user);
    let before_pool = h.token.balance(&h.pool_id);

    let idx = do_shield(&h, 5_000_000, 42);
    assert_eq!(idx, 0);

    assert_eq!(h.token.balance(&h.user), before_user - 5_000_000);
    assert_eq!(h.token.balance(&h.pool_id), before_pool + 5_000_000);
    assert_eq!(h.merkle.next_index(), 1u32);
}

#[test]
fn shield_rejects_over_cap() {
    let h = setup();
    let env = &h.env;
    h.pool.set_deposit_cap(&100);
    let commitment = u256_from_u32(env, 1);
    let mvk_tag = u256_from_u32(env, 2);
    let allow_root = h.asp_membership.get_root();
    let publics = [
        commitment.clone(),
        U256::from_u128(env, 101),
        h.pool.asset_id(),
        h.pool.address_scalar(&h.user),
        allow_root.clone(),
        mvk_tag.clone(),
    ];
    let proof = prove(env, &h.shield_pk, &publics);
    let res = h.pool.try_shield(
        &h.user,
        &101_i128,
        &commitment,
        &mvk_tag,
        &Bytes::new(env),
        &Bytes::new(env),
        &allow_root,
        &proof,
    );
    assert_eq!(res, Err(Ok(Error::WrongAmount)));
}

#[test]
fn shield_rejects_stale_asp_root() {
    let h = setup();
    let env = &h.env;
    let stale_root = u256_from_u32(env, 999); // not the registry root
    let commitment = u256_from_u32(env, 1);
    let mvk_tag = u256_from_u32(env, 2);
    let publics = [
        commitment.clone(),
        U256::from_u128(env, 100),
        h.pool.asset_id(),
        h.pool.address_scalar(&h.user),
        stale_root.clone(),
        mvk_tag.clone(),
    ];
    let proof = prove(env, &h.shield_pk, &publics);
    let res = h.pool.try_shield(
        &h.user,
        &100_i128,
        &commitment,
        &mvk_tag,
        &Bytes::new(env),
        &Bytes::new(env),
        &stale_root,
        &proof,
    );
    assert_eq!(res, Err(Ok(Error::WrongAspRoot)));
}

#[test]
fn shield_rejects_invalid_proof() {
    let h = setup();
    let env = &h.env;
    let commitment = u256_from_u32(env, 1);
    let mvk_tag = u256_from_u32(env, 2);
    let allow_root = h.asp_membership.get_root();
    // Proof generated for different publics than submitted.
    let publics = [
        u256_from_u32(env, 1111),
        U256::from_u128(env, 100),
        h.pool.asset_id(),
        h.pool.address_scalar(&h.user),
        allow_root.clone(),
        mvk_tag.clone(),
    ];
    let proof = prove(env, &h.shield_pk, &publics);
    let res = h.pool.try_shield(
        &h.user,
        &100_i128,
        &commitment, // != 1111 -> public input mismatch
        &mvk_tag,
        &Bytes::new(env),
        &Bytes::new(env),
        &allow_root,
        &proof,
    );
    assert!(res.is_err());
}

struct TransferArgs {
    root: U256,
    n0: U256,
    n1: U256,
    out0: U256,
    out1: U256,
    fee: i128,
    relayer: Address,
    proof: Groth16Proof,
}

fn build_transfer(h: &Harness, n0: u32, n1: u32, out0: u32, out1: u32, fee: i128) -> TransferArgs {
    let env = &h.env;
    let root = h.merkle.current_root();
    let n0 = u256_from_u32(env, n0);
    let n1 = u256_from_u32(env, n1);
    let out0 = u256_from_u32(env, out0);
    let out1 = u256_from_u32(env, out1);
    let relayer = Address::generate(env);
    let ct = Bytes::from_array(env, &[3u8; 8]);
    let ext = h.pool.transfer_ext_hash(&relayer, &fee, &ct, &ct, &ct, &ct);
    #[allow(clippy::cast_sign_loss)]
    let publics = [
        root.clone(),
        h.pool.asset_id(),
        n0.clone(),
        n1.clone(),
        out0.clone(),
        out1.clone(),
        U256::from_u128(env, fee as u128),
        ext,
        u256_from_u32(env, 70),
        u256_from_u32(env, 71),
    ];
    let proof = prove(env, &h.transfer_pk, &publics);
    TransferArgs {
        root,
        n0,
        n1,
        out0,
        out1,
        fee,
        relayer,
        proof,
    }
}

type TryResult = Result<Result<(), ()>, Result<Error, soroban_sdk::InvokeError>>;

fn submit_transfer(h: &Harness, t: &TransferArgs) -> TryResult {
    let env = &h.env;
    let ct = Bytes::from_array(env, &[3u8; 8]);
    h.pool
        .try_transfer(
            &h.user,
            &t.root,
            &t.n0,
            &t.n1,
            &t.out0,
            &t.out1,
            &t.fee,
            &t.relayer,
            &u256_from_u32(env, 70),
            &u256_from_u32(env, 71),
            &ct,
            &ct,
            &ct,
            &ct,
            &t.proof,
        )
        .map(|r| r.map_err(|_| ()))
}

#[test]
fn transfer_spends_inserts_pays_fee_and_replays_idempotently() {
    let h = setup();
    do_shield(&h, 10_000_000, 42);

    let t = build_transfer(&h, 100, 101, 200, 201, 3);
    assert_eq!(submit_transfer(&h, &t), Ok(Ok(())));

    // State: nullifiers spent, two leaves inserted, fee paid.
    assert!(h.nullifiers.is_spent(&t.n0));
    assert!(h.nullifiers.is_spent(&t.n1));
    assert_eq!(h.merkle.next_index(), 3u32); // 1 shield + 2 outputs
    assert_eq!(h.token.balance(&t.relayer), 3);

    // Full replay: idempotent success with NO state change.
    assert_eq!(submit_transfer(&h, &t), Ok(Ok(())));
    assert_eq!(h.merkle.next_index(), 3u32);
    assert_eq!(h.token.balance(&t.relayer), 3); // no second fee

    // Partial replay: one spent + one fresh nullifier -> rejected.
    let t2 = build_transfer(&h, 100, 555, 300, 301, 0);
    assert_eq!(submit_transfer(&h, &t2), Err(Ok(Error::PartialReplay)));
}

#[test]
fn transfer_rejects_unknown_root_and_tampered_ext() {
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;

    // Unknown root.
    let mut t = build_transfer(&h, 1, 2, 3, 4, 0);
    t.root = u256_from_u32(env, 31337);
    assert_eq!(submit_transfer(&h, &t), Err(Ok(Error::UnknownRoot)));

    // Tampered relayer: ext hash differs from the proof's public input.
    let mut t3 = build_transfer(&h, 5, 6, 7, 8, 0);
    t3.relayer = Address::generate(env);
    let res = submit_transfer(&h, &t3);
    assert!(res.is_err(), "tampered relayer must invalidate the proof");
}

#[test]
fn withdraw_pays_out_and_is_replay_safe() {
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;

    let recipient = Address::generate(env);
    let root = h.merkle.current_root();
    let nullifier = u256_from_u32(env, 900);
    let change = u256_from_u32(env, 901);
    let amount: i128 = 4_000_000;
    let deny_root = h.asp_non_membership.get_root();
    let ct = Bytes::from_array(env, &[5u8; 8]);
    let ext = h.pool.withdraw_ext_hash(&recipient, &ct, &ct);
    #[allow(clippy::cast_sign_loss)]
    let publics = [
        root.clone(),
        h.pool.asset_id(),
        nullifier.clone(),
        U256::from_u128(env, amount as u128),
        change.clone(),
        ext,
        deny_root.clone(),
        u256_from_u32(env, 71),
    ];
    let proof = prove(env, &h.unshield_pk, &publics);

    let before = h.token.balance(&recipient);
    h.pool.withdraw(
        &h.user,
        &root,
        &nullifier,
        &change,
        &amount,
        &recipient,
        &u256_from_u32(env, 71),
        &ct,
        &ct,
        &deny_root,
        &proof,
    );
    assert_eq!(h.token.balance(&recipient), before + amount);
    assert!(h.nullifiers.is_spent(&nullifier));
    assert_eq!(h.merkle.next_index(), 2u32); // shield leaf + change leaf

    // Replay: success, but never a second debit.
    h.pool.withdraw(
        &h.user,
        &root,
        &nullifier,
        &change,
        &amount,
        &recipient,
        &u256_from_u32(env, 71),
        &ct,
        &ct,
        &deny_root,
        &proof,
    );
    assert_eq!(h.token.balance(&recipient), before + amount);
    assert_eq!(h.merkle.next_index(), 2u32);
}

#[test]
fn pause_blocks_ops() {
    let h = setup();
    h.pool.pause();
    let env = &h.env;
    let res = h.pool.try_shield(
        &h.user,
        &100_i128,
        &u256_from_u32(env, 1),
        &u256_from_u32(env, 2),
        &Bytes::new(env),
        &Bytes::new(env),
        &u256_from_u32(env, 3),
        &prove(
            env,
            &h.shield_pk,
            &core::array::from_fn::<U256, 6, _>(|_| u256_from_u32(env, 1)),
        ),
    );
    assert_eq!(res, Err(Ok(Error::Paused)));
    h.pool.unpause();
}
