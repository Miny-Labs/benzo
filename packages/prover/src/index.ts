/**
 * @benzo/prover — ProverPort: one proving interface, many runtimes.
 *
 * The Benzo core builds witnesses; a ProverPort turns a witness into a Groth16
 * proof. NodeProver (snarkjs, headless) is the working default used by the CLI
 * and servers. WasmProver / NativeProver are typed stubs the browser and mobile
 * surfaces fill in later — so swapping runtimes never touches core logic.
 */
import {
  NodeProver,
  type CircuitArtifacts,
  type WitnessInput,
  type ProveResult,
  type ProverPort,
} from "@benzo/core";

// The canonical ProverPort + NodeProver live in @benzo/core (so core can type an
// injected prover without depending on this package). Re-exported here so the
// runtime surfaces import every backend from one place.
export type { CircuitArtifacts, WitnessInput, ProveResult, ProverPort };
export { NodeProver };

/** Browser Web Worker (WASM) prover. Stub — provided by apps/web. */
export class WasmProver implements ProverPort {
  readonly name = "wasm";
  async prove(): Promise<ProveResult> {
    throw new Error(
      "WasmProver not implemented yet — the web surface (apps/web) will provide a Web Worker WASM prover.",
    );
  }
}

/** Mobile native prover. Stub — provided by a future React Native surface. */
export class NativeProver implements ProverPort {
  readonly name = "native";
  async prove(): Promise<ProveResult> {
    throw new Error(
      "NativeProver not implemented yet — the mobile surface will provide a native prover.",
    );
  }
}
