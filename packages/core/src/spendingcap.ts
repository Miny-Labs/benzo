/**
 * In-ZK spending policy (Z3).
 *
 * Proves a single payout is WITHIN an approved per-payout cap WITHOUT revealing
 * the payout amount. The spending limit is a circuit constraint (amount <= cap),
 * so an over-cap payout is unprovable — the policy is enforced by cryptography,
 * not by a server check that could be bypassed.
 *
 * The proof binds to the SPECIFIC payout via its public note commitment (the same
 * commitment that lands on-chain when the payout settles), so a verifier can
 * confirm the commitment is a real on-chain note and trust amount <= cap.
 *
 * Public inputs: [commitment, cap, assetId, context].
 */

import { noteCommitment, type Note } from "./notes.js";
import { toWitnessInput, type CircuitArtifacts, type ProveResult, type ProverPort } from "./prover.js";

export interface ProveSpendingCapParams {
  prover: ProverPort; // proving backend (Node / browser WASM / TEE)
  artifacts: CircuitArtifacts; // spending_cap wasm + zkey
  note: Note; // the payout note { amount, recipientPk, blinding, assetId }
  cap: bigint; // the approved per-payout ceiling (the policy limit)
  context?: bigint; // payout/request binding nonce (replay protection)
}

/**
 * Build the witness and generate a spending-cap proof. Throws if `note.amount`
 * exceeds `cap` — the constraint `amount <= cap` is unsatisfiable, so an
 * over-cap payout simply cannot produce a proof (that IS the enforcement).
 */
export async function proveSpendingCap(
  params: ProveSpendingCapParams,
): Promise<ProveResult & { commitment: bigint }> {
  const commitment = noteCommitment(params.note);
  const witness = toWitnessInput({
    commitment,
    cap: params.cap,
    assetId: params.note.assetId,
    context: params.context ?? 0n,
    amount: params.note.amount,
    blinding: params.note.blinding,
    recipientPk: params.note.recipientPk,
  });
  const res = await params.prover.prove(params.artifacts, witness);
  return { ...res, commitment };
}
