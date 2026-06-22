/**
 * Config/env-driven prover construction — so the "tee" proving mode is a real,
 * reachable path (a `PhalaProver` wired to a `DstackAttestationVerifier`), not a
 * dead routing choice. Soundness is identical across modes (proofs verified
 * on-chain); only WHERE the witness is handled differs.
 */
import { type ProverPort, type CircuitArtifacts, type WitnessInput, type ProveResult, NodeProver, PhalaProver } from "./prover.js";
import { makeNodeAttestationVerifier } from "./attestation-node.js";

export type ProverModeEnv = "node" | "tee";

/**
 * Routes each prove() by circuit id: circuits in `localCircuits` use `fallback`,
 * everything else uses `primary`. Lets the small org disclosure/policy proofs run
 * INSIDE the TEE while a heavy circuit the CVM can't hold (e.g. joinsplit_org at
 * 2^18, which needs more RAM than a small CVM has) stays on the local prover.
 * Soundness is unchanged either way (every proof is verified on-chain).
 */
export class RoutingProver implements ProverPort {
  readonly name = "routing";
  constructor(
    private readonly primary: ProverPort,
    private readonly fallback: ProverPort,
    private readonly localCircuits: Set<string>,
  ) {}
  prove(artifacts: CircuitArtifacts, input: WitnessInput): Promise<ProveResult> {
    const id = artifacts.circuit ?? "";
    const useLocal = id !== "" && this.localCircuits.has(id);
    return (useLocal ? this.fallback : this.primary).prove(artifacts, input);
  }
}

export interface TeeProverConfig {
  /** Base URL of the enclave (the verifier hits /quote, the prover /prove). */
  endpoint: string;
  /** Pinned enclave measurement (dstack compose-hash by default). */
  measurement: string;
  /** TCB statuses to accept (defaults inside DstackAttestationVerifier). */
  acceptableStatuses?: string[];
}

/** Build a real attested-TEE prover (PhalaProver + dcap-qvl quote verification). */
export function makeTeeProver(cfg: TeeProverConfig): PhalaProver {
  const verifier = makeNodeAttestationVerifier({ acceptableStatuses: cfg.acceptableStatuses });
  return new PhalaProver(cfg.endpoint, verifier, cfg.measurement);
}

/**
 * Build a prover from environment:
 *   BENZO_PROVER_MODE=tee → PhalaProver(BENZO_PROVER_ENDPOINT, …, BENZO_PROVER_MEASUREMENT)
 *   otherwise             → NodeProver (local snarkjs)
 * Optional: BENZO_PROVER_TCB="UpToDate,SWHardeningNeeded".
 */
export function proverFromEnv(env: Record<string, string | undefined> = process.env): ProverPort {
  const mode = (env.BENZO_PROVER_MODE || "node").toLowerCase();
  if (mode === "tee") {
    const endpoint = env.BENZO_PROVER_ENDPOINT;
    const measurement = env.BENZO_PROVER_MEASUREMENT;
    if (!endpoint || !measurement) {
      throw new Error("tee mode requires BENZO_PROVER_ENDPOINT and BENZO_PROVER_MEASUREMENT");
    }
    const tee = makeTeeProver({
      endpoint,
      measurement,
      acceptableStatuses: env.BENZO_PROVER_TCB?.split(",").map((s) => s.trim()).filter(Boolean),
    });
    // Heavy circuits a small CVM can't prove (default: joinsplit_org @ 2^18) stay
    // on the local prover; all org disclosure/policy/credential proofs go to the TEE.
    const localCsv = env.BENZO_PROVER_LOCAL_CIRCUITS ?? "joinsplit_org";
    const local = localCsv.split(",").map((s) => s.trim()).filter(Boolean);
    if (local.length === 0) return tee;
    return new RoutingProver(tee, new NodeProver(), new Set(local));
  }
  return new NodeProver();
}
