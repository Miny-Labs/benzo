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
import { sealToEnclave } from "./crypto/ecies.js";

export type CircuitName = "shield" | "joinsplit" | "unshield";

export interface CircuitArtifacts {
  /** Path (Node) or URL (browser fetch) of the witness-generator WASM. */
  wasmPath: string;
  /** Path (Node) or URL (browser fetch) of the proving zkey. */
  zkeyPath: string;
  /** Browser-portable: preloaded WASM bytes (fetched once); used over wasmPath. */
  wasm?: Uint8Array;
  /** Browser-portable: preloaded zkey bytes (fetched once); used over zkeyPath. */
  zkey?: Uint8Array;
  /** Opaque circuit id a DelegatedProver sends to a remote prover that already
   *  holds the artifacts (so the wasm/zkey aren't shipped per proof). */
  circuit?: string;
}

export interface ProveResult {
  proof: SnarkjsProof;
  publicSignals: string[];
  sorobanProof: { a: string; b: string; c: string };
  sorobanPublics: string[];
}

type WitnessValue = string | WitnessValue[];
type BigNest = bigint | BigNest[];
export type WitnessInput = Record<string, WitnessValue>;

/** Recursively serialize bigints (any nesting depth — the org join-split needs
 *  3D `mPathElements`) into snarkjs input form. */
function serWitness(v: BigNest): WitnessValue {
  return typeof v === "bigint" ? v.toString() : v.map(serWitness);
}
export function toWitnessInput(values: Record<string, BigNest>): WitnessInput {
  const out: WitnessInput = {};
  for (const [k, v] of Object.entries(values)) out[k] = serWitness(v);
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

/**
 * On-device Groth16 proving via snarkjs — the same proof output as NodeProver,
 * but it accepts preloaded `Uint8Array` artifacts (fetched once in the browser)
 * and never assumes `node:fs`, so it runs in a Web Worker on the user's device.
 * The witness and proving key never leave the device. `packages/proving-worker`
 * wraps this in a Worker so a multi-second proof never freezes the UI thread.
 */
export class WasmProver implements ProverPort {
  readonly name = "wasm";
  constructor(private readonly onProgress?: (stage: string) => void) {}
  async prove(artifacts: CircuitArtifacts, input: WitnessInput): Promise<ProveResult> {
    const wasm = artifacts.wasm ?? artifacts.wasmPath;
    const zkey = artifacts.zkey ?? artifacts.zkeyPath;
    // snarkjs doesn't expose proof-progress, so we mark the meaningful UI
    // boundaries ("proving" → "done") plus forward any internal info logs.
    this.onProgress?.("proving");
    const logger = this.onProgress
      ? { debug: () => {}, info: (m: string) => this.onProgress?.(m), error: () => {} }
      : undefined;
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey, logger);
    this.onProgress?.("done");
    return {
      proof,
      publicSignals,
      sorobanProof: proofToSoroban(proof),
      sorobanPublics: publicsToSoroban(publicSignals),
    };
  }
}

/**
 * Delegated Groth16 proving — sends the witness to a remote prover that holds the
 * artifacts and returns its `ProveResult`. For low-power/mobile devices or large
 * batches (e.g. a big payroll) that can't prove on-device.
 *
 * MVP: a TRUSTED delegate — the witness is sent in clear to an operator-run
 * prover, so use ONLY with an explicitly-trusted endpoint and label it as such.
 * MAINNET MUST make this witness-HIDING (TEE-attested, or an MPC/coSNARK split)
 * so amounts, spend keys, and blindings never leave the device — see
 * docs/ZK-AUDIT-AND-STANDARDS.md B.5.
 */
export class DelegatedProver implements ProverPort {
  readonly name = "delegated";
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * The witness (amounts, spend keys, blindings) is sent to the remote in CLEAR.
     * This MUST be set to true to acknowledge that — otherwise prove() refuses and
     * directs you to PhalaProver (attested, witness-hiding). This guard makes a
     * privacy-defeating delegate impossible to select by accident; the live factory
     * never sets it (it uses PhalaProver).
     */
    private readonly allowClearWitness = false,
  ) {}
  async prove(artifacts: CircuitArtifacts, input: WitnessInput): Promise<ProveResult> {
    if (!this.allowClearWitness) {
      throw new Error(
        "DelegatedProver sends the witness in CLEAR — refusing. Use PhalaProver (attested, witness-hiding) for delegated proving, or construct DelegatedProver(endpoint, fetch, /*allowClearWitness*/ true) to explicitly accept the trust assumption.",
      );
    }
    const circuit = artifacts.circuit ?? artifacts.zkeyPath;
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ circuit, input }),
    });
    if (!res.ok) throw new Error(`delegated prover failed: HTTP ${res.status}`);
    return (await res.json()) as ProveResult;
  }
}

/**
 * The result of verifying an enclave's TDX attestation quote: whether it passed,
 * the pinned code `measurement` (dstack compose-hash by default), the *attested*
 * X25519 public key the witness is sealed to, and the raw RTMR3/MRTD/TCB status.
 */
export interface AttestationResult {
  ok: boolean;
  measurement?: string;
  /** enclave X25519 pubkey (hex) extracted from the verified quote's report_data */
  enclavePublicKey?: string;
  rtmr3?: string;
  mrtd?: string;
  composeHash?: string;
  status?: string;
}

/**
 * Verifies a TEE attestation quote (Phala dstack / Intel TDX) and returns the
 * enclave's code measurement + attested encryption key. Injected so the real
 * quote-verification (dcap-qvl) is pluggable and the prover is unit-testable.
 * See `DstackAttestationVerifier` in attestation.ts for the real implementation.
 */
export interface AttestationVerifier {
  verify(endpoint: string): Promise<AttestationResult>;
}

/**
 * Witness-hiding delegated proving in an ATTESTED Phala TEE — the "tee" proving
 * mode (the user's other choice is on-device WasmProver). Before any witness is
 * transmitted it (1) verifies the enclave's attestation quote and (2) checks the
 * measurement matches the pinned expected value. ONLY then is the witness sent
 * over the attested RA-TLS channel. A failed or mismatched attestation throws
 * WITHOUT transmitting the witness — so a spoofed/tampered enclave can never see
 * the user's amounts, spend keys, or blindings.
 *
 * Soundness is unchanged vs on-device: the proof is still verified on-chain, so
 * a compromised enclave can never mint or double-spend — the worst case is
 * bounded to witness confidentiality.
 */
export class PhalaProver implements ProverPort {
  readonly name = "phala";
  /** @param endpoint base URL of the enclave (verifier hits /quote, prover /prove). */
  constructor(
    private readonly endpoint: string,
    private readonly attestation: AttestationVerifier,
    private readonly expectedMeasurement: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async prove(artifacts: CircuitArtifacts, input: WitnessInput): Promise<ProveResult> {
    // Gate: attest BEFORE sending the witness. Any failure throws here, so the
    // witness is never transmitted to an unverified enclave.
    const att = await this.attestation.verify(this.endpoint);
    if (!att.ok) throw new Error("phala: enclave attestation failed — witness NOT sent");
    if (att.measurement !== this.expectedMeasurement) {
      throw new Error(
        `phala: enclave measurement mismatch (got ${att.measurement ?? "none"}, want ${this.expectedMeasurement}) — witness NOT sent`,
      );
    }
    const circuit = artifacts.circuit ?? artifacts.zkeyPath;
    const base = this.endpoint.replace(/\/+$/, "");
    // Seal the witness to the enclave's *attested* X25519 key so the TLS-terminating
    // gateway only ever sees ciphertext. (If no key was attested, we refuse rather
    // than fall back to plaintext — confidentiality must not silently downgrade.)
    if (!att.enclavePublicKey) {
      throw new Error("phala: no attested enclave key — refusing to send witness in clear");
    }
    const body = JSON.stringify({ circuit, enc: sealToEnclave(att.enclavePublicKey, { input }) });
    const res = await this.fetchImpl(`${base}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`phala prover failed: HTTP ${res.status}`);
    // The enclave returns the canonical snarkjs proof; the CLIENT re-derives the
    // Soroban bytes, so a compromised enclave can't forge the on-chain encoding.
    const { proof, publicSignals } = (await res.json()) as {
      proof: SnarkjsProof;
      publicSignals: string[];
    };
    return {
      proof,
      publicSignals,
      sorobanProof: proofToSoroban(proof),
      sorobanPublics: publicsToSoroban(publicSignals),
    };
  }
}
