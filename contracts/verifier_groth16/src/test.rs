#![allow(clippy::expect_used)] // tests may .expect() on known-good fixtures
use super::*;
use ark_bn254::{Bn254, Fr as ArkFr};
use ark_ff::{BigInteger, Field, PrimeField};
use ark_groth16::Groth16;
use ark_relations::gr1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_snark::SNARK;
use ark_std::rand::{SeedableRng, rngs::StdRng};
use soroban_sdk::{BytesN, Env, Symbol, Vec, testutils::Address as _};
use soroban_utils::{g1_bytes_from_ark, g2_bytes_from_ark, vk_bytes_from_ark};

extern crate std;

/// Trivial multiplier circuit: public input c, witnesses a, b with a*b == c.
#[derive(Clone)]
struct MulCircuit<F: Field> {
    a: F,
    b: F,
}

impl<F: Field> ConstraintSynthesizer<F> for MulCircuit<F> {
    fn generate_constraints(self, cs: ConstraintSystemRef<F>) -> Result<(), SynthesisError> {
        let c_val = self.a * self.b;
        let c = cs.new_input_variable(|| Ok(c_val))?;
        let a = cs.new_witness_variable(|| Ok(self.a))?;
        let b = cs.new_witness_variable(|| Ok(self.b))?;
        cs.enforce_r1cs_constraint(|| a.into(), || b.into(), || c.into())?;
        Ok(())
    }
}

fn fr_from_ark(env: &Env, value: ArkFr) -> Bn254Fr {
    let bytes = value.into_bigint().to_bytes_be();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&bytes);
    Bn254Fr::from_bytes(BytesN::from_array(env, &buf))
}

fn build_proof_seeded(
    env: &Env,
    seed: u64,
    a: u64,
    b: u64,
) -> (VerificationKeyBytes, Groth16Proof, Vec<Bn254Fr>) {
    let mut rng = StdRng::seed_from_u64(seed);
    let a = ArkFr::from(a);
    let b = ArkFr::from(b);
    let circuit = MulCircuit { a, b };
    let (pk, vk) =
        Groth16::<Bn254>::circuit_specific_setup(circuit.clone(), &mut rng).expect("setup");
    let proof = Groth16::<Bn254>::prove(&pk, circuit, &mut rng).expect("prove");

    let proof_soroban = Groth16Proof {
        a: G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.a))),
        b: G2Affine::from_bytes(BytesN::from_array(env, &g2_bytes_from_ark(proof.b))),
        c: G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.c))),
    };
    let vk_bytes = vk_bytes_from_ark(env, &vk);
    let mut public_inputs: Vec<Bn254Fr> = Vec::new(env);
    public_inputs.push_back(fr_from_ark(env, a * b));
    (vk_bytes, proof_soroban, public_inputs)
}

fn build_proof(env: &Env) -> (VerificationKeyBytes, Groth16Proof, Vec<Bn254Fr>) {
    build_proof_seeded(env, 7, 6, 7)
}

/// Build N proofs that all share ONE verification key — the shape a batch must
/// accept. One `circuit_specific_setup` fixes the VK; each `(a,b)` pair is then
/// proved against it. This mirrors a real payroll run: many spends, one circuit.
fn build_shared_vk_batch(
    env: &Env,
    seed: u64,
    pairs: &[(u64, u64)],
) -> (VerificationKeyBytes, Vec<Groth16Proof>, Vec<Vec<Bn254Fr>>) {
    let mut rng = StdRng::seed_from_u64(seed);
    // Setup defines the VK from the circuit STRUCTURE; the witness here is dummy.
    let setup_circuit = MulCircuit {
        a: ArkFr::from(1u64),
        b: ArkFr::from(1u64),
    };
    let (pk, vk) =
        Groth16::<Bn254>::circuit_specific_setup(setup_circuit, &mut rng).expect("setup");
    let vk_bytes = vk_bytes_from_ark(env, &vk);

    let mut proofs: Vec<Groth16Proof> = Vec::new(env);
    let mut inputs: Vec<Vec<Bn254Fr>> = Vec::new(env);
    for &(a, b) in pairs {
        let af = ArkFr::from(a);
        let bf = ArkFr::from(b);
        let proof = Groth16::<Bn254>::prove(&pk, MulCircuit { a: af, b: bf }, &mut rng)
            .expect("prove");
        proofs.push_back(Groth16Proof {
            a: G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.a))),
            b: G2Affine::from_bytes(BytesN::from_array(env, &g2_bytes_from_ark(proof.b))),
            c: G1Affine::from_bytes(BytesN::from_array(env, &g1_bytes_from_ark(proof.c))),
        });
        let mut pin: Vec<Bn254Fr> = Vec::new(env);
        pin.push_back(fr_from_ark(env, af * bf));
        inputs.push_back(pin);
    }
    (vk_bytes, proofs, inputs)
}

#[test]
fn verify_valid_proof_with_vk() {
    let env = Env::default();
    let (vk, proof, public_inputs) = build_proof(&env);
    let result = BenzoVerifier::verify_with_vk(&env, &vk, proof, public_inputs);
    assert_eq!(result, Ok(true));
}

#[test]
fn reject_wrong_public_input() {
    let env = Env::default();
    let (vk, proof, _) = build_proof(&env);
    let mut bad_inputs: Vec<Bn254Fr> = Vec::new(&env);
    bad_inputs.push_back(fr_from_ark(&env, ArkFr::from(43u64)));
    let result = BenzoVerifier::verify_with_vk(&env, &vk, proof, bad_inputs);
    assert_eq!(result, Err(Error::InvalidProof));
}

#[test]
fn reject_malformed_public_inputs_len() {
    let env = Env::default();
    let (vk, proof, _) = build_proof(&env);
    let empty: Vec<Bn254Fr> = Vec::new(&env);
    let result = BenzoVerifier::verify_with_vk(&env, &vk, proof, empty);
    assert_eq!(result, Err(Error::MalformedPublicInputs));
}

#[test]
fn vk_registry_set_once_and_verify() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(BenzoVerifier, (admin.clone(),));
    let client = BenzoVerifierClient::new(&env, &contract_id);

    let (vk, proof, public_inputs) = build_proof(&env);
    let vk_id = Symbol::new(&env, "TRIVIAL");
    client.set_vk(&vk_id, &vk);
    assert!(client.has_vk(&vk_id));

    // Second registration must fail (immutability).
    let second = client.try_set_vk(&vk_id, &vk);
    assert_eq!(second, Err(Ok(Error::VkAlreadySet)));

    assert!(client.verify_proof(&vk_id, &proof, &public_inputs));
}

#[test]
fn reject_too_many_public_inputs() {
    // VK expects exactly 1 public input (IC len 2); supplying 2 must be rejected.
    let env = Env::default();
    let (vk, proof, _) = build_proof(&env);
    let mut too_many: Vec<Bn254Fr> = Vec::new(&env);
    too_many.push_back(fr_from_ark(&env, ArkFr::from(42u64)));
    too_many.push_back(fr_from_ark(&env, ArkFr::from(43u64)));
    let result = BenzoVerifier::verify_with_vk(&env, &vk, proof, too_many);
    assert_eq!(result, Err(Error::MalformedPublicInputs));
}

#[test]
fn reject_tampered_proof() {
    // A well-formed but wrong proof (A and C swapped) must fail the pairing,
    // returning InvalidProof (fail-closed) rather than silently verifying.
    let env = Env::default();
    let (vk, proof, public_inputs) = build_proof(&env);
    let tampered = Groth16Proof {
        a: proof.c.clone(),
        b: proof.b.clone(),
        c: proof.a.clone(),
    };
    let result = BenzoVerifier::verify_with_vk(&env, &vk, tampered, public_inputs);
    assert_eq!(result, Err(Error::InvalidProof));
}

#[test]
fn reject_cross_circuit_proof() {
    // A valid proof from one trusted setup must NOT verify against another
    // setup's VK (no cross-circuit confusion).
    let env = Env::default();
    let (vk1, _proof1, _publics1) = build_proof_seeded(&env, 7, 6, 7);
    let (_vk2, proof2, publics2) = build_proof_seeded(&env, 123, 8, 9);
    let result = BenzoVerifier::verify_with_vk(&env, &vk1, proof2, publics2);
    assert_eq!(result, Err(Error::InvalidProof));
}

#[test]
fn set_vk_requires_admin_auth() {
    // set_vk is admin-only — it must fail without admin auth.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(BenzoVerifier, (admin.clone(),));
    let client = BenzoVerifierClient::new(&env, &contract_id);
    let (vk, _proof, _publics) = build_proof(&env);
    env.mock_auths(&[]); // revoke the blanket auth
    let res = client.try_set_vk(&Symbol::new(&env, "X"), &vk);
    assert!(res.is_err(), "set_vk without admin auth must fail");
}

#[test]
fn reject_empty_ic_vk_at_registration() {
    // A structurally malformed VK (empty IC) must be rejected at set_vk, not
    // silently stored to fail later when a real proof arrives.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(BenzoVerifier, (admin.clone(),));
    let client = BenzoVerifierClient::new(&env, &contract_id);

    let (vk, _proof, _publics) = build_proof(&env);
    let bad_vk = VerificationKeyBytes {
        alpha: vk.alpha.clone(),
        beta: vk.beta.clone(),
        gamma: vk.gamma.clone(),
        delta: vk.delta.clone(),
        ic: Vec::new(&env), // empty IC
    };
    let result = client.try_set_vk(&Symbol::new(&env, "BAD"), &bad_vk);
    assert_eq!(result, Err(Ok(Error::MalformedVk)));
    assert!(!client.has_vk(&Symbol::new(&env, "BAD")));
}

#[test]
fn rotate_vk_overwrites_for_governed_rotation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(BenzoVerifier, (admin.clone(),));
    let client = BenzoVerifierClient::new(&env, &contract_id);

    let (vk, proof, public_inputs) = build_proof(&env);
    let vk_id = Symbol::new(&env, "TRANSFER");
    client.set_vk(&vk_id, &vk);
    assert!(client.verify_proof(&vk_id, &proof, &public_inputs));

    // rotate_vk overwrites the existing key (the governed upgrade path).
    // Rotating to a fresh setup's VK invalidates proofs under the old key.
    let (vk2, proof2, publics2) = {
        // independent setup => different VK
        let mut rng = StdRng::seed_from_u64(123);
        let a = ArkFr::from(8u64);
        let b = ArkFr::from(9u64);
        let circuit = MulCircuit { a, b };
        let (pk, vk) =
            Groth16::<Bn254>::circuit_specific_setup(circuit.clone(), &mut rng).expect("setup");
        let proof = Groth16::<Bn254>::prove(&pk, circuit, &mut rng).expect("prove");
        let ps = Groth16Proof {
            a: G1Affine::from_bytes(BytesN::from_array(&env, &g1_bytes_from_ark(proof.a))),
            b: G2Affine::from_bytes(BytesN::from_array(&env, &g2_bytes_from_ark(proof.b))),
            c: G1Affine::from_bytes(BytesN::from_array(&env, &g1_bytes_from_ark(proof.c))),
        };
        let mut publics: Vec<Bn254Fr> = Vec::new(&env);
        publics.push_back(fr_from_ark(&env, a * b));
        (vk_bytes_from_ark(&env, &vk), ps, publics)
    };
    client.rotate_vk(&vk_id, &vk2);

    // New key verifies its matching proof; the old proof no longer verifies.
    assert!(client.verify_proof(&vk_id, &proof2, &publics2));
    let stale = client.try_verify_proof(&vk_id, &proof, &public_inputs);
    assert!(stale.is_err(), "proof under the rotated-out key must fail");
}

// ----------------------------------------------------------- batch verification

#[test]
fn batch_verify_valid_run() {
    // N proofs sharing one VK all verify together in a single combined check.
    let env = Env::default();
    let (vk, proofs, inputs) =
        build_shared_vk_batch(&env, 7, &[(6, 7), (3, 4), (5, 5), (2, 9)]);
    let result = BenzoVerifier::verify_batch_with_vk(&env, &vk, proofs, inputs);
    assert_eq!(result, Ok(true));
}

#[test]
fn batch_single_proof_matches_single_verify() {
    // A batch of one is equivalent to a single verify (regression anchor).
    let env = Env::default();
    let (vk, proofs, inputs) = build_shared_vk_batch(&env, 11, &[(6, 7)]);
    assert_eq!(
        BenzoVerifier::verify_batch_with_vk(&env, &vk, proofs, inputs),
        Ok(true)
    );
}

#[test]
fn batch_empty_is_rejected() {
    // An empty batch proves nothing and must be rejected, not vacuously true.
    let env = Env::default();
    let (vk, _p, _i) = build_shared_vk_batch(&env, 7, &[(6, 7)]);
    let empty_p: Vec<Groth16Proof> = Vec::new(&env);
    let empty_i: Vec<Vec<Bn254Fr>> = Vec::new(&env);
    assert_eq!(
        BenzoVerifier::verify_batch_with_vk(&env, &vk, empty_p, empty_i),
        Err(Error::MalformedPublicInputs)
    );
}

#[test]
fn batch_rejects_one_tampered_proof() {
    // A single invalid proof anywhere in the batch must fail the whole check —
    // an invalid proof cannot hide behind valid ones (the core soundness claim).
    let env = Env::default();
    let (vk, proofs, inputs) = build_shared_vk_batch(&env, 7, &[(6, 7), (3, 4), (5, 5)]);
    // Tamper the middle proof by swapping its A and C points.
    let mut bad = proofs.clone();
    let p1 = proofs.get(1).expect("p1");
    bad.set(
        1,
        Groth16Proof {
            a: p1.c.clone(),
            b: p1.b.clone(),
            c: p1.a.clone(),
        },
    );
    assert_eq!(
        BenzoVerifier::verify_batch_with_vk(&env, &vk, bad, inputs),
        Err(Error::InvalidProof)
    );
}

#[test]
fn batch_rejects_wrong_public_input() {
    // One proof carrying a public input that does not match its proof must fail.
    let env = Env::default();
    let (vk, proofs, inputs) = build_shared_vk_batch(&env, 7, &[(6, 7), (3, 4), (5, 5)]);
    let mut bad_inputs = inputs.clone();
    let mut wrong: Vec<Bn254Fr> = Vec::new(&env);
    wrong.push_back(fr_from_ark(&env, ArkFr::from(999u64))); // != 3*4
    bad_inputs.set(1, wrong);
    assert_eq!(
        BenzoVerifier::verify_batch_with_vk(&env, &vk, proofs, bad_inputs),
        Err(Error::InvalidProof)
    );
}

#[test]
fn batch_rejects_two_proofs_with_swapped_c() {
    // Adversarial forgery shape: take two valid proofs and swap their C points,
    // making BOTH individually invalid while preserving the multiset of points.
    // A weak (non-Fiat-Shamir-bound) combiner might let these cancel; ours must
    // reject because the in-contract challenges bind each proof's own C.
    let env = Env::default();
    let (vk, proofs, inputs) = build_shared_vk_batch(&env, 7, &[(6, 7), (3, 4)]);
    let p0 = proofs.get(0).expect("p0");
    let p1 = proofs.get(1).expect("p1");
    let mut swapped: Vec<Groth16Proof> = Vec::new(&env);
    swapped.push_back(Groth16Proof {
        a: p0.a.clone(),
        b: p0.b.clone(),
        c: p1.c.clone(), // foreign C
    });
    swapped.push_back(Groth16Proof {
        a: p1.a.clone(),
        b: p1.b.clone(),
        c: p0.c.clone(), // foreign C
    });
    assert_eq!(
        BenzoVerifier::verify_batch_with_vk(&env, &vk, swapped, inputs),
        Err(Error::InvalidProof)
    );
}

#[test]
fn batch_rejects_foreign_vk_proof() {
    // A valid proof from a DIFFERENT trusted setup cannot ride inside a batch
    // verified against vk1 (no cross-circuit confusion in the batched path).
    let env = Env::default();
    let (vk1, proofs1, inputs1) = build_shared_vk_batch(&env, 7, &[(6, 7), (3, 4)]);
    let (_vk2, proofs2, inputs2) = build_shared_vk_batch(&env, 123, &[(8, 9)]);
    let mut mixed = proofs1.clone();
    mixed.push_back(proofs2.get(0).expect("foreign proof"));
    let mut mixed_inputs = inputs1.clone();
    mixed_inputs.push_back(inputs2.get(0).expect("foreign inputs"));
    let _ = proofs1;
    let _ = inputs1;
    assert_eq!(
        BenzoVerifier::verify_batch_with_vk(&env, &vk1, mixed, mixed_inputs),
        Err(Error::InvalidProof)
    );
}

#[test]
fn batch_verify_via_registered_vk() {
    // End-to-end through the registry + public entrypoint (storage path).
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(BenzoVerifier, (admin.clone(),));
    let client = BenzoVerifierClient::new(&env, &contract_id);

    let (vk, proofs, inputs) = build_shared_vk_batch(&env, 7, &[(6, 7), (3, 4), (5, 5)]);
    let vk_id = Symbol::new(&env, "BATCHRUN");
    client.set_vk(&vk_id, &vk);
    assert!(client.verify_batch(&vk_id, &proofs, &inputs));

    // A tampered batch through the same entrypoint must fail closed.
    let mut bad = proofs.clone();
    let p0 = proofs.get(0).expect("p0");
    bad.set(
        0,
        Groth16Proof {
            a: p0.c.clone(),
            b: p0.b.clone(),
            c: p0.a.clone(),
        },
    );
    assert!(client.try_verify_batch(&vk_id, &bad, &inputs).is_err());
}
