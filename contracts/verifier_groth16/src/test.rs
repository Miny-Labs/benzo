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
