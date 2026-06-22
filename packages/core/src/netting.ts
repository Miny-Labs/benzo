/**
 * Cross-entity private netting (Z8).
 *
 * Two orgs hold mutual inter-company invoices (A owes B `aOwesB`, B owes A
 * `bOwesA`). This proves they settle ONLY the net difference, computed correctly
 * (net = |aOwesB - bOwesA|, paid by the larger debtor), WITHOUT revealing either
 * gross amount. Only the net + payer direction are public.
 *
 * Public inputs: [net, payerIsA, context].
 */

import { toWitnessInput, type CircuitArtifacts, type ProveResult, type ProverPort } from "./prover.js";

export interface ProveCrossNettingParams {
  prover: ProverPort; // proving backend
  artifacts: CircuitArtifacts; // cross_netting wasm + zkey
  aOwesB: bigint; // A's invoice total to B (PRIVATE)
  bOwesA: bigint; // B's invoice total to A (PRIVATE)
  context?: bigint; // settlement binding nonce (replay protection)
}

/**
 * Build the witness and prove the net is correct. Returns the public `net` and
 * `payerIsA` (1 if A pays B, 0 if B pays A) alongside the proof.
 */
export async function proveCrossNetting(
  params: ProveCrossNettingParams,
): Promise<ProveResult & { net: bigint; payerIsA: bigint }> {
  const payerIsA = params.aOwesB >= params.bOwesA ? 1n : 0n;
  const net = payerIsA === 1n ? params.aOwesB - params.bOwesA : params.bOwesA - params.aOwesB;
  const witness = toWitnessInput({
    net,
    payerIsA,
    context: params.context ?? 0n,
    aOwesB: params.aOwesB,
    bOwesA: params.bOwesA,
  });
  const res = await params.prover.prove(params.artifacts, witness);
  return { ...res, net, payerIsA };
}
