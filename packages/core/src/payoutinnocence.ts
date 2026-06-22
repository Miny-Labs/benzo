/**
 * Per-payout proof-of-innocence (Z4).
 *
 * Proves the RECIPIENT of a payout is NOT on a sanctions / deny set (an OFAC-style
 * deny SMT) WITHOUT revealing who the recipient is. A sanctioned recipient cannot
 * produce a non-inclusion proof, so that payout is provably blocked — the deny
 * screen is enforced by cryptography, bound to the payout's note commitment.
 *
 * Public inputs: [denyRoot, commitment, assetId, context].
 */

import { noteCommitment, type Note } from "./notes.js";
import { toWitnessInput, type CircuitArtifacts, type ProveResult, type ProverPort } from "./prover.js";

/** Non-inclusion witness from the on-chain deny SMT (from its `find_key` view). */
export interface SmtNonMembershipWitness {
  siblings: bigint[];
  oldKey: bigint;
  oldValue: bigint;
  isOld0: bigint; // 1 if the closest node is the zero node
}

export interface ProvePayoutInnocenceParams {
  prover: ProverPort; // proving backend (Node / browser WASM / TEE)
  artifacts: CircuitArtifacts; // payout_innocence wasm + zkey
  note: Note; // the payout note { amount, recipientPk, blinding, assetId }
  denyRoot: bigint; // root of the sanctions/deny SMT (keyed by recipientPk)
  smt: SmtNonMembershipWitness; // non-inclusion witness for recipientPk
  context?: bigint; // payout/request binding nonce (replay protection)
}

/** Build the witness and generate a per-payout proof-of-innocence. */
export async function provePayoutInnocence(
  params: ProvePayoutInnocenceParams,
): Promise<ProveResult & { commitment: bigint }> {
  const commitment = noteCommitment(params.note);
  const witness = toWitnessInput({
    denyRoot: params.denyRoot,
    commitment,
    assetId: params.note.assetId,
    context: params.context ?? 0n,
    amount: params.note.amount,
    blinding: params.note.blinding,
    recipientPk: params.note.recipientPk,
    smtSiblings: params.smt.siblings,
    smtOldKey: params.smt.oldKey,
    smtOldValue: params.smt.oldValue,
    smtIsOld0: params.smt.isOld0,
  });
  const res = await params.prover.prove(params.artifacts, witness);
  return { ...res, commitment };
}
