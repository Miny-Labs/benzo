/**
 * Headless Groth16 proving (Node — never a browser).
 *
 * Wraps snarkjs `groth16.fullProve` over the compiled circuit artifacts
 * (witness-generator WASM + proving zkey) and returns both the snarkjs JSON
 * and the Soroban-encoded forms.
 */

// snarkjs has no bundled types; the surface we use is tiny.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import * as snarkjs from "snarkjs";
import { proofToSoroban, publicsToSoroban, type SnarkjsProof } from "./crypto/groth16.js";

export type CircuitName = "shield" | "joinsplit" | "unshield";

export interface CircuitArtifacts {
  wasmPath: string;
  zkeyPath: string;
}

export interface ProveResult {
  proof: SnarkjsProof;
  publicSignals: string[];
  sorobanProof: { a: string; b: string; c: string };
  sorobanPublics: string[];
}

export type WitnessInput = Record<string, string | string[] | string[][]>;

/** Serialize bigints (and nested arrays of them) into snarkjs input form. */
export function toWitnessInput(
  values: Record<string, bigint | bigint[] | bigint[][]>,
): WitnessInput {
  const out: WitnessInput = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (Array.isArray(v) && typeof v[0] === "bigint")
      out[k] = (v as bigint[]).map(String);
    else out[k] = (v as bigint[][]).map((row) => row.map(String));
  }
  return out;
}

export async function prove(
  artifacts: CircuitArtifacts,
  input: WitnessInput,
): Promise<ProveResult> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    artifacts.wasmPath,
    artifacts.zkeyPath,
  );
  return {
    proof,
    publicSignals,
    sorobanProof: proofToSoroban(proof),
    sorobanPublics: publicsToSoroban(publicSignals),
  };
}

/** Local verification against a snarkjs verification_key.json object. */
export async function verifyLocal(
  vk: unknown,
  publicSignals: string[],
  proof: SnarkjsProof,
): Promise<boolean> {
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

/**
 * A pluggable proving backend: turns a witness into a Groth16 proof. Core builds
 * witnesses and calls a `ProverPort`; the runtime (Node / browser WASM / native)
 * decides *where* the proof is generated — so swapping runtimes never touches
 * protocol logic. This is the seam that lets the same `BenzoClient` run headless
 * on the CLI and client-side in the browser.
 */
export interface ProverPort {
  readonly name: string;
  prove(artifacts: CircuitArtifacts, input: WitnessInput): Promise<ProveResult>;
}

/** Headless Groth16 proving via snarkjs (Node/server). The default backend. */
export class NodeProver implements ProverPort {
  readonly name = "node";
  prove(artifacts: CircuitArtifacts, input: WitnessInput): Promise<ProveResult> {
    return prove(artifacts, input);
  }
}
