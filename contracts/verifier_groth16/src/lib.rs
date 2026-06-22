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
    Address, Bytes, BytesN, Env, Symbol, Vec, contract, contracterror, contractevent,
    contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine as G1Affine, Bn254G2Affine as G2Affine},
    vec,
};

soroban_sdk::contractmeta!(key = "binver", val = "0.1.0");
soroban_sdk::contractmeta!(key = "name", val = "benzo-verifier-groth16");

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
fn validate_vk(env: &Env, vk: &VerificationKeyBytes) -> Result<(), Error> {
    // Non-empty IC: one commitment per public input plus the constant term.
    if vk.ic.is_empty() {
        return Err(Error::MalformedVk);
    }
    // Reject degenerate trapdoor (G2) points that enable trivial proof forgery.
    // In the verification equation e(-A,B)*e(alpha,beta)*e(vk_x,gamma)*e(C,delta),
    // if gamma == delta the gamma/delta terms collapse so an attacker can balance
    // arbitrary public inputs against C (the Veil/VeilCash drain class). Equal or
    // zero alpha/beta/gamma/delta never occur in an honest Groth16 setup, so a VK
    // exhibiting them is malformed or adversarial — refuse it at registration
    // rather than letting it silently accept forged proofs on the money path.
    let zero_g1 = BytesN::<64>::from_array(env, &[0u8; 64]);
    let zero_g2 = BytesN::<128>::from_array(env, &[0u8; 128]);
    if vk.gamma == vk.delta
        || vk.gamma == vk.beta
        || vk.delta == vk.beta
        || vk.alpha == zero_g1
        || vk.beta == zero_g2
        || vk.gamma == zero_g2
        || vk.delta == zero_g2
    {
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
        validate_vk(&env, &vk)?;
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
        validate_vk(&env, &vk)?;
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
        let key = DataKey::Vk(vk_id);
        let vk: VerificationKeyBytes = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::VkNotSet)?;
        // CAP-0078 TTL maintenance: the VK is written once and read on every
        // verification, so keep it from being archived. Inlined (not via
        // soroban-utils) to keep this verifier's wasm lean. Threshold-gated, so
        // it is a no-op until the entry nears expiry.
        const DAY_IN_LEDGERS: u32 = 17_280;
        env.storage()
            .persistent()
            .extend_ttl(&key, 30 * DAY_IN_LEDGERS, 90 * DAY_IN_LEDGERS);
        Self::verify_with_vk(&env, &vk, proof, public_inputs)
    }

    /// Core Groth16 verification with an explicit VK (also used by tests).
    ///
    /// Fail-closed: every error path returns `Err(..)`, and `verify_proof`'s
    /// caller (e.g. the pool) treats anything but `Ok(true)` as rejection.
    /// Point validity is NOT re-checked here by hand because it is enforced one
    /// layer down: `G1Affine::from_bytes` / `G2Affine::from_bytes` (CAP-0074)
    /// reject any bytes that are not a canonical on-curve, correct-subgroup
    /// point, trapping the call. So "no explicit subgroup check" is by design,
    /// not an omission. The public-input count is bound exactly to the VK's IC
    /// length below, so a proof cannot smuggle extra/fewer inputs.
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

    /// Batch-verify N Groth16 proofs that **all share one verification key**,
    /// against the VK registered under `vk_id`.
    ///
    /// Sound via a random linear combination (Fiat-Shamir): the per-proof
    /// verification equations are combined with challenges `r_i` derived
    /// **in-contract** from a transcript that binds every proof point and every
    /// public input. Deriving `r_i` here (rather than accepting them from the
    /// caller) is the load-bearing soundness step — a prover able to choose
    /// `r_i` could cancel an invalid proof against a valid one. Because every
    /// proof shares the same VK, the `alpha/beta`, `gamma` and `delta` terms
    /// collapse across the batch, so the whole run is checked with ONE pairing
    /// check of `N + 3` terms instead of `N` separate 4-term checks.
    ///
    /// HONEST FRAMING: this is a batched *verification* optimisation — NOT
    /// recursion and NOT "N proofs folded into one proof". Cost is still LINEAR
    /// in N (the per-proof `e(A_i, B_i)` terms cannot merge), and the caller
    /// still applies each proof's on-chain state transition. Returns `Ok(true)`
    /// iff every proof verifies; any failure returns `Err(Error::InvalidProof)`
    /// so callers fail closed.
    pub fn verify_batch(
        env: Env,
        vk_id: Symbol,
        proofs: Vec<Groth16Proof>,
        pub_inputs: Vec<Vec<Bn254Fr>>,
    ) -> Result<bool, Error> {
        let key = DataKey::Vk(vk_id);
        let vk: VerificationKeyBytes = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::VkNotSet)?;
        const DAY_IN_LEDGERS: u32 = 17_280;
        env.storage()
            .persistent()
            .extend_ttl(&key, 30 * DAY_IN_LEDGERS, 90 * DAY_IN_LEDGERS);
        Self::verify_batch_with_vk(&env, &vk, proofs, pub_inputs)
    }

    /// Core batched verification with an explicit VK (also used by tests).
    ///
    /// Builds the combined pairing vectors:
    ///   G1 = [ -r_0·A_0, .., -r_{n-1}·A_{n-1}, (Σr_i)·α, Σ r_i·vk_x_i, Σ r_i·C_i ]
    ///   G2 = [    B_0,   ..,      B_{n-1},          β,        γ,            δ      ]
    /// and checks the product of pairings equals identity in one call.
    pub fn verify_batch_with_vk(
        env: &Env,
        vk: &VerificationKeyBytes,
        proofs: Vec<Groth16Proof>,
        pub_inputs: Vec<Vec<Bn254Fr>>,
    ) -> Result<bool, Error> {
        let n = proofs.len();
        // An empty batch proves nothing; a mismatched outer length is malformed.
        if n == 0 || pub_inputs.len() != n {
            return Err(Error::MalformedPublicInputs);
        }
        let bn = env.crypto().bn254();

        // ---- Fiat-Shamir transcript: bind the VK anchor + every proof point +
        // every public input, so the challenges below are unpredictable to the
        // prover (a prover-chosen challenge would break batch soundness).
        let mut transcript = Bytes::new(env);
        transcript.extend_from_array(b"BENZO_BATCH_GROTH16_V1");
        transcript.extend_from_array(&vk.alpha.to_array());
        for i in 0..n {
            let p = proofs.get(i).ok_or(Error::MalformedPublicInputs)?;
            transcript.extend_from_array(&p.a.to_array());
            transcript.extend_from_array(&p.b.to_array());
            transcript.extend_from_array(&p.c.to_array());
            let pis = pub_inputs.get(i).ok_or(Error::MalformedPublicInputs)?;
            // Each proof's public-input count must match the VK exactly.
            if pis.len().checked_add(1) != Some(vk.ic.len()) {
                return Err(Error::MalformedPublicInputs);
            }
            for j in 0..pis.len() {
                let s = pis.get(j).ok_or(Error::MalformedPublicInputs)?;
                transcript.extend_from_array(&s.to_bytes().to_array());
            }
        }
        let seed: BytesN<32> = env.crypto().keccak256(&transcript).into();

        // ---- shared VK points, decoded once
        let alpha = G1Affine::from_bytes(vk.alpha.clone());
        let beta = G2Affine::from_bytes(vk.beta.clone());
        let gamma = G2Affine::from_bytes(vk.gamma.clone());
        let delta = G2Affine::from_bytes(vk.delta.clone());
        let ic0 = vk.ic.get(0).ok_or(Error::MalformedPublicInputs)?;

        let mut g1_points: Vec<G1Affine> = Vec::new(env);
        let mut g2_points: Vec<G2Affine> = Vec::new(env);

        // Σ r_i (for the collapsed alpha term), and the running r_i·vk_x_i / r_i·C_i sums.
        let mut sum_r = Bn254Fr::from_bytes(BytesN::from_array(env, &[0u8; 32]));
        let mut vkx_acc: Option<G1Affine> = None;
        let mut c_acc: Option<G1Affine> = None;

        for i in 0..n {
            let p = proofs.get(i).ok_or(Error::MalformedPublicInputs)?;
            let pis = pub_inputs.get(i).ok_or(Error::MalformedPublicInputs)?;

            // r_i = Fr(keccak256(seed || i)); from_bytes reduces mod the scalar field.
            let mut cbuf = Bytes::new(env);
            cbuf.extend_from_array(&seed.to_array());
            cbuf.extend_from_array(&i.to_be_bytes());
            let r_bytes: BytesN<32> = env.crypto().keccak256(&cbuf).into();
            let r_i = Bn254Fr::from_bytes(r_bytes);

            // -r_i·A_i paired with B_i — these terms do NOT collapse (each B_i differs).
            let neg_a = -(&p.a);
            g1_points.push_back(bn.g1_mul(&neg_a, &r_i));
            g2_points.push_back(p.b.clone());

            // vk_x_i = IC0 + Σ_j pis[j]·IC[j+1]
            let mut vk_x = G1Affine::from_bytes(ic0.clone());
            for j in 0..pis.len() {
                let s = pis.get(j).ok_or(Error::MalformedPublicInputs)?;
                let ic_idx = j.checked_add(1).ok_or(Error::MalformedPublicInputs)?;
                let v = vk.ic.get(ic_idx).ok_or(Error::MalformedPublicInputs)?;
                vk_x = bn.g1_add(&vk_x, &bn.g1_mul(&G1Affine::from_bytes(v), &s));
            }

            // accumulate Σ r_i·vk_x_i , Σ r_i·C_i , Σ r_i
            let rvkx = bn.g1_mul(&vk_x, &r_i);
            vkx_acc = Some(match vkx_acc {
                None => rvkx,
                Some(acc) => bn.g1_add(&acc, &rvkx),
            });
            let rc = bn.g1_mul(&p.c, &r_i);
            c_acc = Some(match c_acc {
                None => rc,
                Some(acc) => bn.g1_add(&acc, &rc),
            });
            sum_r = bn.fr_add(&sum_r, &r_i);
        }

        // Collapsed shared terms (one each, not N):
        //   e((Σr_i)·α, β) · e(Σ r_i·vk_x_i, γ) · e(Σ r_i·C_i, δ)
        g1_points.push_back(bn.g1_mul(&alpha, &sum_r));
        g2_points.push_back(beta);
        g1_points.push_back(vkx_acc.ok_or(Error::MalformedPublicInputs)?);
        g2_points.push_back(gamma);
        g1_points.push_back(c_acc.ok_or(Error::MalformedPublicInputs)?);
        g2_points.push_back(delta);

        if bn.pairing_check(g1_points, g2_points) {
            Ok(true)
        } else {
            Err(Error::InvalidProof)
        }
    }
}

#[cfg(test)]
mod test;
