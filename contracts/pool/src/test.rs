#![allow(clippy::expect_used)] // tests may .expect() on known-good fixtures

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
    jsplitorg_pk: ProvingKey<Bn254>,
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
    let (shield_pk, shield_vk) = mk_keys(7);
    let (transfer_pk, transfer_vk) = mk_keys(11);
    let (unshield_pk, unshield_vk) = mk_keys(9);
    // JSPLITORG (org M-of-N transfer) has the SAME 11 public inputs as TRANSFER.
    let (jsplitorg_pk, jsplitorg_vk) = mk_keys(11);
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
    verifier.set_vk(
        &Symbol::new(&env, "JSPLITORG"),
        &vk_bytes_from_ark(&env, &jsplitorg_vk),
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
        jsplitorg_pk,
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
    let mvk_root = u256_from_u32(env, 7);
    let publics = [
        commitment.clone(),
        U256::from_u128(env, amount as u128),
        asset_id,
        depositor,
        allow_root.clone(),
        mvk_tag.clone(),
        mvk_root.clone(),
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
        &mvk_root,
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
        u256_from_u32(env, 7),
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
        &u256_from_u32(env, 7),
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
        u256_from_u32(env, 7),
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
        &u256_from_u32(env, 7),
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
        u256_from_u32(env, 7),
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
        &u256_from_u32(env, 7),
        &proof,
    );
    // A non-verifying proof surfaces the pool's typed error (and no longer
    // traps the invocation — see pool::verify's `try_verify_proof` path).
    assert_eq!(res, Err(Ok(Error::InvalidProof)));
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
        u256_from_u32(env, 7),
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
            &u256_from_u32(env, 7),
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

// ---- org M-of-N dual-control transfer (transfer_org / JSPLITORG) -----------

/// Like `build_transfer`, but the proof is made under the JSPLITORG proving key
/// (the on-chain stand-in for the in-circuit M-of-N joinsplit_org proof).
fn build_transfer_org(h: &Harness, n0: u32, n1: u32, out0: u32, out1: u32, fee: i128) -> TransferArgs {
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
        root.clone(), h.pool.asset_id(), n0.clone(), n1.clone(), out0.clone(), out1.clone(),
        U256::from_u128(env, fee as u128), ext, u256_from_u32(env, 70), u256_from_u32(env, 71),
        u256_from_u32(env, 7),
    ];
    let proof = prove(env, &h.jsplitorg_pk, &publics);
    TransferArgs { root, n0, n1, out0, out1, fee, relayer, proof }
}

fn submit_transfer_org(h: &Harness, t: &TransferArgs) -> TryResult {
    let env = &h.env;
    let ct = Bytes::from_array(env, &[3u8; 8]);
    h.pool
        .try_transfer_org(
            &h.user, &t.root, &t.n0, &t.n1, &t.out0, &t.out1, &t.fee, &t.relayer,
            &u256_from_u32(env, 70), &u256_from_u32(env, 71), &ct, &ct, &ct, &ct,
            &u256_from_u32(env, 7), &t.proof,
        )
        .map(|r| r.map_err(|_| ()))
}

#[test]
fn transfer_org_settles_under_jsplitorg_vk_and_is_vk_gated() {
    let h = setup();
    do_shield(&h, 10_000_000, 42);

    // An org M-of-N proof settles through transfer_org (same bookkeeping as transfer).
    let t = build_transfer_org(&h, 900, 901, 910, 911, 0);
    assert_eq!(submit_transfer_org(&h, &t), Ok(Ok(())));
    assert!(h.nullifiers.is_spent(&t.n0));
    assert!(h.nullifiers.is_spent(&t.n1));
    assert_eq!(h.merkle.next_index(), 3u32); // 1 shield + 2 org outputs

    // VK GATE — the dual-control guarantee on-chain: a proof made for the consumer
    // TRANSFER vk is REJECTED by transfer_org (so a single-key consumer proof can
    // never move org funds), and an org JSPLITORG proof is REJECTED by the consumer
    // transfer entry. Each entry only accepts its own verification key.
    let consumer = build_transfer(&h, 800, 801, 810, 811, 0);
    assert!(submit_transfer_org(&h, &consumer).is_err(), "consumer TRANSFER proof must NOT settle via transfer_org");
    let org = build_transfer_org(&h, 700, 701, 710, 711, 0);
    assert!(submit_transfer(&h, &org).is_err(), "org JSPLITORG proof must NOT settle via the consumer transfer");
}

// ---- batched org settlement (batch_transfer_org: one combined verification) ---

/// One `OrgSpend` proved under the given key. `build_org_spend` uses the real
/// JSPLITORG key; passing a different key forges a "wrong-VK" item for negatives.
fn build_org_spend_pk(
    h: &Harness,
    pk: &ProvingKey<Bn254>,
    n0: u32,
    n1: u32,
    out0: u32,
    out1: u32,
    fee: i128,
) -> OrgSpend {
    let env = &h.env;
    let root = h.merkle.current_root();
    let nullifier0 = u256_from_u32(env, n0);
    let nullifier1 = u256_from_u32(env, n1);
    let out_commitment0 = u256_from_u32(env, out0);
    let out_commitment1 = u256_from_u32(env, out1);
    let relayer = Address::generate(env);
    let ct = Bytes::from_array(env, &[3u8; 8]);
    let ext = h.pool.transfer_ext_hash(&relayer, &fee, &ct, &ct, &ct, &ct);
    let mvk_tag0 = u256_from_u32(env, 70);
    let mvk_tag1 = u256_from_u32(env, 71);
    let registered_mvk_root = u256_from_u32(env, 7);
    #[allow(clippy::cast_sign_loss)]
    let publics = [
        root.clone(),
        h.pool.asset_id(),
        nullifier0.clone(),
        nullifier1.clone(),
        out_commitment0.clone(),
        out_commitment1.clone(),
        U256::from_u128(env, fee as u128),
        ext,
        mvk_tag0.clone(),
        mvk_tag1.clone(),
        registered_mvk_root.clone(),
    ];
    let proof = prove(env, pk, &publics);
    OrgSpend {
        root,
        nullifier0,
        nullifier1,
        out_commitment0,
        out_commitment1,
        fee,
        relayer,
        mvk_tag0,
        mvk_tag1,
        note_ct0: ct.clone(),
        note_ct1: ct.clone(),
        mvk_ct0: ct.clone(),
        mvk_ct1: ct,
        registered_mvk_root,
        proof,
    }
}

fn build_org_spend(h: &Harness, n0: u32, n1: u32, out0: u32, out1: u32, fee: i128) -> OrgSpend {
    build_org_spend_pk(h, &h.jsplitorg_pk, n0, n1, out0, out1, fee)
}

fn spends_of(env: &Env, items: StdVec<OrgSpend>) -> soroban_sdk::Vec<OrgSpend> {
    let mut v = soroban_sdk::Vec::new(env);
    for it in items {
        v.push_back(it);
    }
    v
}

#[test]
fn batch_transfer_org_settles_whole_run_in_one_verification() {
    // LOGIC test (budget lifted). The test-host BN254/Poseidon cost model is an
    // uncalibrated placeholder (CAP-0074 calibration is still TBD), so the per-tx
    // N cap is NOT measured here — it is measured on live testnet (#140) with the
    // real joinsplit_org proofs and the real depth-32 tree. Here we prove the
    // ENTRYPOINT settles a whole run correctly with ONE combined verification.
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;
    // Disable mainnet per-tx resource-limit enforcement: this is a CORRECTNESS
    // test, and at the production tree depth the 2N merkle inserts blow the real
    // per-tx budget at low single-digit N (the binding constraint — measured for
    // real on testnet in #140). `disable_resource_limits` is the sanctioned hook
    // for "contracts still being optimized" (the cheap batch merkle-insert is the
    // pending optimization).
    h.env.cost_estimate().disable_resource_limits();
    h.env.cost_estimate().budget().reset_unlimited();

    let s0 = build_org_spend(&h, 900, 901, 910, 911, 0);
    let s1 = build_org_spend(&h, 902, 903, 912, 913, 0);
    let s2 = build_org_spend(&h, 904, 905, 914, 915, 0);
    let nulls = [
        s0.nullifier0.clone(), s0.nullifier1.clone(),
        s1.nullifier0.clone(), s1.nullifier1.clone(),
        s2.nullifier0.clone(), s2.nullifier1.clone(),
    ];
    let spends = spends_of(env, std::vec![s0, s1, s2]);

    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &spends)
        .map(|x| x.map_err(|_| ()));
    assert_eq!(r, Ok(Ok(())), "an all-valid batch settles in one verification");

    for n in &nulls {
        assert!(h.nullifiers.is_spent(n), "every input nullifier is spent");
    }
    // 1 shield leaf + 3 spends * 2 outputs = 7 leaves inserted.
    assert_eq!(h.merkle.next_index(), 7u32);
}

#[test]
fn batch_logic_scales_with_lifted_budget() {
    // The settlement loop (2N nullifier-spends + 2N merkle inserts) is what bounds
    // N per tx, not the proof. With the budget lifted, the SAME entrypoint settles
    // a 5-payout run correctly — confirming the cap is a budget limit, not a logic
    // limit. (On the real network the cap is single-digit; measured on testnet.)
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;
    h.env.cost_estimate().disable_resource_limits();
    h.env.cost_estimate().budget().reset_unlimited();

    let mut items = std::vec::Vec::new();
    let mut nulls = std::vec::Vec::new();
    for k in 0..5u32 {
        let base = 900 + k * 10;
        let s = build_org_spend(&h, base, base + 1, base + 2, base + 3, 0);
        nulls.push(s.nullifier0.clone());
        nulls.push(s.nullifier1.clone());
        items.push(s);
    }
    let spends = spends_of(env, items);

    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &spends)
        .map(|x| x.map_err(|_| ()));
    assert_eq!(r, Ok(Ok(())), "a 5-payout batch settles with the budget lifted");
    for n in &nulls {
        assert!(h.nullifiers.is_spent(n));
    }
    // 1 shield leaf + 5 spends * 2 outputs = 11 leaves.
    assert_eq!(h.merkle.next_index(), 11u32);
}

#[test]
fn batch_two_spends_fit_mainnet_budget() {
    // MEASUREMENT (no budget lift): with verify_batch + the subtree-merge batched
    // insert, a 2-payout run settles under the REAL mainnet per-tx limits. Both
    // the per-leaf-insert AND the storage-only-batch versions failed this. (Exact
    // ceiling is calibration-dependent — TBD for BN254/Poseidon — so #140 measures
    // the true max-N on live testnet.)
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;

    let s0 = build_org_spend(&h, 900, 901, 910, 911, 0);
    let s1 = build_org_spend(&h, 902, 903, 912, 913, 0);
    let spends = spends_of(env, std::vec![s0, s1]);

    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &spends)
        .map(|x| x.map_err(|_| ()));
    assert_eq!(r, Ok(Ok(())), "a 2-payout batch fits the mainnet budget");
    assert_eq!(h.merkle.next_index(), 5u32); // 1 shield + 2*2 outputs
}

#[test]
fn batch_empty_is_rejected() {
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let spends: soroban_sdk::Vec<OrgSpend> = soroban_sdk::Vec::new(&h.env);
    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &spends)
        .map(|x| x.map_err(|_| ()));
    assert!(r != Ok(Ok(())), "an empty batch proves nothing and must be rejected");
}

#[test]
fn batch_rejects_intra_batch_double_spend() {
    // Two items in one batch reuse nullifier 900 — must be rejected BEFORE any
    // state is written (a single circuit can't see across proofs; the pool does).
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;

    let s0 = build_org_spend(&h, 900, 901, 910, 911, 0);
    let s1 = build_org_spend(&h, 900, 902, 912, 913, 0); // reuses 900
    let reused = s0.nullifier0.clone();
    let spends = spends_of(env, std::vec![s0, s1]);

    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &spends)
        .map(|x| x.map_err(|_| ()));
    assert!(r != Ok(Ok(())), "intra-batch double-spend must be rejected");
    assert!(!h.nullifiers.is_spent(&reused), "no state may be applied on a rejected batch");
}

#[test]
fn batch_rejects_already_spent_input() {
    // A batch that tries to re-spend a nullifier already spent by an earlier
    // settlement fails closed, applying nothing.
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;

    // Settle one org transfer first so its nullifier 900 is spent on-chain.
    let first = build_org_spend(&h, 900, 901, 910, 911, 0);
    let spent = first.nullifier0.clone();
    let one = spends_of(env, std::vec![first]);
    assert_eq!(
        h.pool.try_batch_transfer_org(&h.user, &one).map(|x| x.map_err(|_| ())),
        Ok(Ok(()))
    );
    assert!(h.nullifiers.is_spent(&spent));

    // Now a batch reusing 900 must be rejected.
    let s = build_org_spend(&h, 900, 999, 920, 921, 0);
    let fresh = s.nullifier1.clone();
    let bad = spends_of(env, std::vec![s]);
    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &bad)
        .map(|x| x.map_err(|_| ()));
    assert!(r != Ok(Ok(())), "re-spending an on-chain nullifier must be rejected");
    assert!(!h.nullifiers.is_spent(&fresh), "the fresh input must not be spent on a rejected batch");
}

#[test]
fn batch_rejects_one_invalid_proof_and_applies_nothing() {
    // Two valid org spends + one whose proof is under the CONSUMER transfer key
    // (wrong VK). The combined verification fails, and because it runs before any
    // state mutation, NONE of the six nullifiers are spent (all-or-nothing).
    let h = setup();
    do_shield(&h, 10_000_000, 42);
    let env = &h.env;

    let s0 = build_org_spend(&h, 900, 901, 910, 911, 0);
    let s1 = build_org_spend(&h, 902, 903, 912, 913, 0);
    let bad = build_org_spend_pk(&h, &h.transfer_pk, 904, 905, 914, 915, 0); // wrong VK
    let nulls = [
        s0.nullifier0.clone(), s0.nullifier1.clone(),
        s1.nullifier0.clone(), s1.nullifier1.clone(),
        bad.nullifier0.clone(), bad.nullifier1.clone(),
    ];
    let spends = spends_of(env, std::vec![s0, s1, bad]);

    let r = h
        .pool
        .try_batch_transfer_org(&h.user, &spends)
        .map(|x| x.map_err(|_| ()));
    assert!(r != Ok(Ok(())), "a batch with one invalid proof must be rejected");
    for n in &nulls {
        assert!(!h.nullifiers.is_spent(n), "a rejected batch applies no state");
    }
    assert_eq!(h.merkle.next_index(), 1u32, "no commitments inserted (only the shield leaf)");
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
        u256_from_u32(env, 7),
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
        &u256_from_u32(env, 7),
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
        &u256_from_u32(env, 7),
        &proof,
    );
    assert_eq!(h.token.balance(&recipient), before + amount);
    assert_eq!(h.merkle.next_index(), 2u32);
}

#[test]
fn set_verifier_rotates_without_touching_state() {
    let h = setup();
    // Shield one note so the pool holds custody + tree state.
    do_shield(&h, 5_000_000, 42);
    let before_index = h.merkle.next_index();
    let before_balance = h.token.balance(&h.pool_id);

    // Rotate to a brand-new verifier (admin-gated). Custody + tree unchanged.
    let env = &h.env;
    let admin = Address::generate(env);
    let new_verifier = env.register(benzo_verifier_groth16::BenzoVerifier, (admin,));
    h.pool.set_verifier(&new_verifier);

    assert_eq!(h.pool.verifier(), new_verifier);
    assert_eq!(h.merkle.next_index(), before_index);
    assert_eq!(h.token.balance(&h.pool_id), before_balance);
}

/// Negative auth: the admin-only money-path governance ops must fail without
/// admin auth (catches a regression that drops the `require_admin`).
#[test]
fn admin_ops_require_admin_auth() {
    let h = setup();
    let new_verifier = h.env.register(benzo_verifier_groth16::BenzoVerifier, (h.user.clone(),));
    h.env.mock_auths(&[]); // revoke the blanket auth granted in setup
    assert!(h.pool.try_pause().is_err(), "pause without admin auth must fail");
    assert!(
        h.pool.try_set_verifier(&new_verifier).is_err(),
        "set_verifier without admin auth must fail"
    );
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
        &u256_from_u32(env, 7),
        &prove(
            env,
            &h.shield_pk,
            &core::array::from_fn::<U256, 7, _>(|_| u256_from_u32(env, 1)),
        ),
    );
    assert_eq!(res, Err(Ok(Error::Paused)));
    h.pool.unpause();
}

/// Turnstile backstop: a withdrawal exceeding the net shielded supply is
/// rejected even with a VALID proof — so a forged proof / circuit-soundness bug
/// can never drain more than was actually deposited (Zcash turnstile invariant).
#[test]
fn withdraw_exceeding_supply_is_rejected_by_turnstile() {
    let h = setup();
    do_shield(&h, 5_000_000, 42); // net supply = 5 USDC
    assert_eq!(h.pool.total_shielded(), 5_000_000);
    let env = &h.env;

    let recipient = Address::generate(env);
    let root = h.merkle.current_root();
    let nullifier = u256_from_u32(env, 905);
    let change = u256_from_u32(env, 906);
    let amount: i128 = 9_000_000; // > the 5 USDC supply
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
        u256_from_u32(env, 7),
    ];
    let proof = prove(env, &h.unshield_pk, &publics); // a VALID proof for the over-amount

    let before = h.token.balance(&recipient);
    let res = h.pool.try_withdraw(
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
        &u256_from_u32(env, 7),
        &proof,
    );
    assert_eq!(res, Err(Ok(Error::InsufficientPoolSupply)));
    // No payout, supply untouched, and the nullifier is NOT spent (revertable).
    assert_eq!(h.token.balance(&recipient), before);
    assert_eq!(h.pool.total_shielded(), 5_000_000);
    assert!(!h.nullifiers.is_spent(&nullifier));
}

/// total_shielded tracks net supply: deposits add, a valid withdrawal subtracts.
#[test]
fn total_shielded_tracks_net_supply() {
    let h = setup();
    assert_eq!(h.pool.total_shielded(), 0);
    do_shield(&h, 10_000_000, 42);
    do_shield(&h, 3_000_000, 43);
    assert_eq!(h.pool.total_shielded(), 13_000_000);

    let env = &h.env;
    let recipient = Address::generate(env);
    let root = h.merkle.current_root();
    let nullifier = u256_from_u32(env, 910);
    let change = u256_from_u32(env, 911);
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
        u256_from_u32(env, 7),
    ];
    let proof = prove(env, &h.unshield_pk, &publics);
    h.pool.withdraw(
        &h.user, &root, &nullifier, &change, &amount, &recipient,
        &u256_from_u32(env, 71), &ct, &ct, &deny_root, &u256_from_u32(env, 7), &proof,
    );
    assert_eq!(h.pool.total_shielded(), 9_000_000); // 13 − 4
}

/// Authorized-MVK registry: once configured, the pool pins registered_mvk_root
/// to a known root of the registry — the on-chain half of the audit P0. An
/// unknown root is rejected with WrongMvkRoot before any note is custodied.
#[test]
fn mvk_registry_rejects_unknown_root() {
    let h = setup();
    let env = &h.env;
    // A fresh, empty merkle instance as the authorized-MVK registry.
    let admin = Address::generate(env);
    let reg = env.register(benzo_merkle::BenzoMerkleTree, (admin, 16u32));
    h.pool.set_mvk_registry(&reg);

    let commitment = u256_from_u32(env, 4242);
    let mvk_tag = u256_from_u32(env, 2);
    let allow_root = h.asp_membership.get_root();
    let publics = [
        commitment.clone(),
        U256::from_u128(env, 1_000_000),
        h.pool.asset_id(),
        h.pool.address_scalar(&h.user),
        allow_root.clone(),
        mvk_tag.clone(),
        u256_from_u32(env, 7), // not a known root of the empty registry
    ];
    let proof = prove(env, &h.shield_pk, &publics);
    let res = h.pool.try_shield(
        &h.user,
        &1_000_000_i128,
        &commitment,
        &mvk_tag,
        &Bytes::new(env),
        &Bytes::new(env),
        &allow_root,
        &u256_from_u32(env, 7),
        &proof,
    );
    assert_eq!(res, Err(Ok(Error::WrongMvkRoot)));
}

/// Verifier-boundary canonical-form guard: a public input >= the BN254 field
/// modulus is rejected with NonCanonicalPublicInput BEFORE the proof is verified
/// (a payload that parses is not a valid statement — push_input fails closed).
#[test]
fn shield_rejects_noncanonical_public_input() {
    let h = setup();
    let env = &h.env;
    // 2^256-1 is strictly greater than the BN254 scalar field modulus.
    let huge = U256::from_be_bytes(env, &Bytes::from_array(env, &[0xFFu8; 32]));
    let mvk_tag = u256_from_u32(env, 2);
    let allow_root = h.asp_membership.get_root();
    let publics = [
        huge.clone(),
        U256::from_u128(env, 1_000_000),
        h.pool.asset_id(),
        h.pool.address_scalar(&h.user),
        allow_root.clone(),
        mvk_tag.clone(),
        u256_from_u32(env, 7),
    ];
    let proof = prove(env, &h.shield_pk, &publics);
    let res = h.pool.try_shield(
        &h.user,
        &1_000_000_i128,
        &huge,
        &mvk_tag,
        &Bytes::new(env),
        &Bytes::new(env),
        &allow_root,
        &u256_from_u32(env, 7),
        &proof,
    );
    assert_eq!(res, Err(Ok(Error::NonCanonicalPublicInput)));
}

// ── Property-based invariant tests (proptest) ────────────────────────────────
// Randomized coverage of the three soundness invariants, beyond the fixed-amount
// unit tests above: (1) value conservation on deposits, (2) the turnstile supply
// backstop — TotalShielded = Σdeposits − Σwithdrawals, never over-withdrawn, the
// containment that bounds the blast radius of any undiscovered circuit bug to
// actually-deposited funds, and (3) nullifier no-double-spend (idempotent replay).
// Case counts are capped because each case generates REAL Groth16 proofs.
mod invariants {
    use super::*;
    use proptest::prelude::*;

    /// Attempt a withdraw with a real proof; returns true iff it settled on-chain.
    fn attempt_withdraw(h: &Harness, amount: i128, nf: u32, change_id: u32, recipient: &Address) -> bool {
        let env = &h.env;
        let root = h.merkle.current_root(); // always a known root
        let nullifier = u256_from_u32(env, nf);
        let change = u256_from_u32(env, change_id);
        let deny_root = h.asp_non_membership.get_root();
        let ct = Bytes::from_array(env, &[5u8; 8]);
        let ext = h.pool.withdraw_ext_hash(recipient, &ct, &ct);
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
            u256_from_u32(env, 7),
        ];
        let proof = prove(env, &h.unshield_pk, &publics);
        matches!(
            h.pool.try_withdraw(
                &h.user, &root, &nullifier, &change, &amount, recipient,
                &u256_from_u32(env, 71), &ct, &ct, &deny_root, &u256_from_u32(env, 7), &proof,
            ),
            Ok(Ok(()))
        )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(16))]

        /// (1) value conservation + (2) turnstile backstop: every deposit sums
        /// exactly into TotalShielded, a valid withdraw subtracts, and an
        /// over-withdraw beyond remaining supply is rejected (supply never < 0).
        #[test]
        fn turnstile_conserves_supply(
            deposits in prop::collection::vec(1u64..=50_000_000u64, 1..4),
            withdraw_frac in 0u64..=100u64,
        ) {
            let h = setup();
            let mut total: i128 = 0;
            for (i, &d) in deposits.iter().enumerate() {
                do_shield(&h, d as i128, 1000 + i as u32);
                total += d as i128;
                prop_assert_eq!(h.pool.total_shielded(), total);
            }
            let recipient = Address::generate(&h.env);
            // Withdraw a fraction of the supply (≥1, ≤ total) — must settle + decrement.
            let w = ((total as u128 * u128::from(withdraw_frac) / 100) as i128).clamp(1, total);
            prop_assert!(attempt_withdraw(&h, w, 9000, 9001, &recipient));
            let remaining = total - w;
            prop_assert_eq!(h.pool.total_shielded(), remaining);
            prop_assert!(h.pool.total_shielded() >= 0);
            // Over-withdraw beyond remaining supply (fresh nullifier) → backstop rejects.
            prop_assert!(!attempt_withdraw(&h, remaining + 1, 9002, 9003, &recipient));
            prop_assert_eq!(h.pool.total_shielded(), remaining); // atomically unchanged
        }

        /// (3) nullifier no-double-spend: a spent nullifier never debits twice,
        /// regardless of the replayed amount (idempotent replay).
        #[test]
        fn nullifier_no_double_spend(amount in 1_000u64..=4_000_000u64, nf in 1u32..=200_000u32) {
            let h = setup();
            do_shield(&h, 10_000_000, 7);
            let recipient = Address::generate(&h.env);
            let before = h.token.balance(&recipient);
            prop_assert!(attempt_withdraw(&h, amount as i128, nf, nf.wrapping_add(1_000_000), &recipient));
            prop_assert!(h.nullifiers.is_spent(&u256_from_u32(&h.env, nf)));
            let after_first = h.token.balance(&recipient);
            prop_assert_eq!(after_first, before + i128::from(amount));
            // Replay the SAME nullifier (different change leaf) → idempotent, no 2nd debit.
            let _ = attempt_withdraw(&h, amount as i128, nf, nf.wrapping_add(2_000_000), &recipient);
            prop_assert_eq!(h.token.balance(&recipient), after_first);
        }
    }
}
