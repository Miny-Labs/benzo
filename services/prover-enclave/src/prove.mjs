/**
 * In-enclave Groth16 proving core (snarkjs).
 *
 * Runs INSIDE the Phala dstack CVM. Loads the circuit artifacts that were baked
 * into the image at build time and turns a witness into a Groth16 proof. It
 * returns the *canonical snarkjs* proof + public signals ONLY — the Soroban
 * encoding is intentionally done client-side (the client re-derives the on-chain
 * bytes from this proof), so a compromised enclave can never slip a mismatched
 * encoding past the caller. Soundness stays on-chain regardless.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
// Artifacts are copied to /app/artifacts/<circuit>/... in the image (see Dockerfile).
const ARTIFACT_ROOT = process.env.BENZO_ARTIFACT_ROOT || join(here, "..", "artifacts");

/** The circuits this enclave is provisioned to prove. */
export const CIRCUITS = Object.freeze([
  "shield",
  "joinsplit",
  "unshield",
  "kyc_credential",
  "funds_attestation",
  // Business / org circuits (the managed-service side proves these on the TEE):
  "proof_of_sum_org",
  "proof_of_balance_org",
  "spending_cap",
  "payout_innocence",
  "payroll_computation",
  "org_spend_auth",
  "kyb_credential",
  "cross_netting",
  "joinsplit_org",
]);

function artifactPaths(circuit) {
  if (!CIRCUITS.includes(circuit)) {
    throw new Error(`unknown circuit '${circuit}' (have: ${CIRCUITS.join(", ")})`);
  }
  return {
    wasmPath: join(ARTIFACT_ROOT, circuit, `${circuit}_js`, `${circuit}.wasm`),
    zkeyPath: join(ARTIFACT_ROOT, circuit, `${circuit}.zkey`),
  };
}

/** Throws unless every bundled artifact is present and readable (image sanity). */
export function assertArtifacts() {
  for (const c of CIRCUITS) {
    const { wasmPath, zkeyPath } = artifactPaths(c);
    readFileSync(wasmPath); // throws if missing
    readFileSync(zkeyPath);
  }
}

/**
 * Prove `circuit` over `input` (snarkjs JSON witness form).
 * Returns { proof, publicSignals } — the raw snarkjs output.
 */
export async function proveCircuit(circuit, input) {
  const { wasmPath, zkeyPath } = artifactPaths(circuit);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  return { proof, publicSignals };
}
