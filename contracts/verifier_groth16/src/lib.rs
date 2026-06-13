#![no_std]

//! Benzo Groth16 verifier over BN254 (CAP-0074 host functions).
//!
//! A stateless-by-design verifier keyed by circuit id (`vk_id`). Verification
//! keys (snarkjs `verification_key.json`, converted to Soroban byte encoding
//! off-chain) are uploaded once per circuit by the admin and then immutable —
//! so circuits can evolve (new ids) without redeploying the pool.
//!
//! Verification is the canonical Groth16 pairing equation evaluated with a
//! single `bn254` multi-pairing check:
//! `e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1`

extern crate alloc;

pub use contract_types::{Groth16Error, Groth16Proof, VerificationKeyBytes};
use soroban_sdk::{
    Address, Env, Symbol, Vec, contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine as G1Affine, Bn254G2Affine as G2Affine},
    vec,
};

/// Emitted when a VK is first registered (audit trail: changes which proofs
/// the pool will accept).
#[contractevent]
#[derive(Clone)]
pub struct VkSetEvent {
    /// Circuit id the VK was registered under
    #[topic]
    pub vk_id: Symbol,
}

/// Emitted on governed VK rotation (audit trail: hot-swaps verification logic
/// on the money path, so a compromised-admin swap is detectable off-chain).
#[contractevent]
#[derive(Clone)]
pub struct VkRotatedEvent {
    /// Circuit id whose VK was rotated
    #[topic]
    pub vk_id: Symbol,
}

/// Contract error types for the verifier registry.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// No verification key registered under this vk_id
    VkNotSet = 1,
    /// A verification key is already registered under this vk_id (immutable)
    VkAlreadySet = 2,
    /// Contract is not initialized
    NotInitialized = 3,
    /// The pairing product did not equal identity (invalid proof)
    InvalidProof = 4,
    /// The public inputs length does not match the verification key
    MalformedPublicInputs = 5,
    /// The verification key is structurally malformed (e.g. empty IC)
    MalformedVk = 6,
}

/// Reject a structurally invalid VK at registration rather than letting it
/// fail silently when the first real proof arrives. Point byte-lengths are
/// already type-enforced (BytesN<64>/<128>); the IC vector length is not, so
/// an empty IC (no public-input commitments) is the case to catch here.
fn validate_vk(vk: &VerificationKeyBytes) -> Result<(), Error> {
    if vk.ic.is_empty() {
        return Err(Error::MalformedVk);
    }
    Ok(())
}

/// Storage keys
#[contracttype]
#[derive(Clone, Debug)]
enum DataKey {
    /// Administrator allowed to register verification keys
    Admin,
    /// Verification key for a given circuit id
    Vk(Symbol),
}

#[contract]
pub struct BenzoVerifier;

#[contractimpl]
impl BenzoVerifier {
    /// Initialize the verifier with an admin who may register VKs.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().persistent().set(&DataKey::Admin, &admin);
    }

    /// Register a verification key for a circuit id. One-time per id.
    pub fn set_vk(env: Env, vk_id: Symbol, vk: VerificationKeyBytes) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        validate_vk(&vk)?;
        let key = DataKey::Vk(vk_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::VkAlreadySet);
        }
        env.storage().persistent().set(&key, &vk);
        VkSetEvent { vk_id }.publish(&env);
        Ok(())
    }

    /// Return true if a VK is registered for the circuit id.
    pub fn has_vk(env: Env, vk_id: Symbol) -> bool {
        env.storage().persistent().has(&DataKey::Vk(vk_id))
    }

    /// Governed verifying-key rotation (BENZO §7.5/§10.4 upgrade path).
    ///
    /// Distinct from `set_vk` (which is one-time-immutable): `rotate_vk`
    /// overwrites an existing VK and is gated to the admin (a multisig in
    /// production). Used to roll a hardened circuit's key without redeploying.
    pub fn rotate_vk(env: Env, vk_id: Symbol, vk: VerificationKeyBytes) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        validate_vk(&vk)?;
        env.storage().persistent().set(&DataKey::Vk(vk_id.clone()), &vk);
        VkRotatedEvent { vk_id }.publish(&env);
        Ok(())
    }

    /// Verify a Groth16 proof against the VK registered for `vk_id`.
    ///
    /// Returns `Ok(true)` iff the proof verifies; an invalid proof returns
    /// `Err(Error::InvalidProof)` so calling contracts fail closed.
    pub fn verify_proof(
        env: Env,
        vk_id: Symbol,
        proof: Groth16Proof,
        public_inputs: Vec<Bn254Fr>,
    ) -> Result<bool, Error> {
        let vk: VerificationKeyBytes = env
            .storage()
            .persistent()
            .get(&DataKey::Vk(vk_id))
            .ok_or(Error::VkNotSet)?;
        Self::verify_with_vk(&env, &vk, proof, public_inputs)
    }

    /// Core Groth16 verification with an explicit VK (also used by tests).
    pub fn verify_with_vk(
        env: &Env,
        vk: &VerificationKeyBytes,
        proof: Groth16Proof,
        pub_inputs: Vec<Bn254Fr>,
    ) -> Result<bool, Error> {
        let bn = env.crypto().bn254();

        if pub_inputs.len().checked_add(1) != Some(vk.ic.len()) {
            return Err(Error::MalformedPublicInputs);
        }

        let ic0 = vk.ic.get(0).ok_or(Error::MalformedPublicInputs)?;
        let mut vk_x = G1Affine::from_bytes(ic0);

        for i in 0..pub_inputs.len() {
            let s = pub_inputs.get(i).ok_or(Error::MalformedPublicInputs)?;
            let ic_idx = i.checked_add(1).ok_or(Error::MalformedPublicInputs)?;
            let v = vk.ic.get(ic_idx).ok_or(Error::MalformedPublicInputs)?;
            let prod = bn.g1_mul(&G1Affine::from_bytes(v), &s);
            vk_x = bn.g1_add(&vk_x, &prod);
        }

        // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
        #[allow(clippy::arithmetic_side_effects)]
        let neg_a = -proof.a;

        let g1_points = vec![
            env,
            neg_a,
            G1Affine::from_bytes(vk.alpha.clone()),
            vk_x,
            proof.c,
        ];
        let g2_points = vec![
            env,
            proof.b,
            G2Affine::from_bytes(vk.beta.clone()),
            G2Affine::from_bytes(vk.gamma.clone()),
            G2Affine::from_bytes(vk.delta.clone()),
        ];
        if bn.pairing_check(g1_points, g2_points) {
            Ok(true)
        } else {
            Err(Error::InvalidProof)
        }
    }
}

#[cfg(test)]
mod test;
