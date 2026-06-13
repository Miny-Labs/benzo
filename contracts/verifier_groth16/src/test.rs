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

fn build_proof(env: &Env) -> (VerificationKeyBytes, Groth16Proof, Vec<Bn254Fr>) {
    let mut rng = StdRng::seed_from_u64(7);
    let a = ArkFr::from(6u64);
    let b = ArkFr::from(7u64);
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

    assert_eq!(client.verify_proof(&vk_id, &proof, &public_inputs), true);
}
