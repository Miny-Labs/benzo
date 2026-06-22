/**
 * Proof-of-sum / confidential disclose-total.
 *
 * Generates a zero-knowledge proof that the holder's notes in the pool tree sum
 * to EXACTLY `claimedTotal`, revealing only that total — the cryptographic
 * replacement for the old plaintext decrypt-and-sum disclosure (which leaked
 * every individual amount to the auditor). Public inputs:
 * [root, claimedTotal, assetId, context].
 *
 * COMPLETENESS: this proves "I own notes summing to claimedTotal", NOT "these
 * are ALL my in-scope notes" — a discloser could still under-report by omitting
 * a note. The set-completeness guarantee composes with the authorized-MVK
 * registry binding; see docs/ZK-AUDIT-AND-STANDARDS.md B.3.
 */

import type { MerkleTreeMirror } from "./merkle.js";
import {
  verifyLocal,
  toWitnessInput,
  type CircuitArtifacts,
  type ProveResult,
  type ProverPort,
} from "./prover.js";

/** Maximum notes a single proof-of-sum can aggregate (circuit-fixed). */
export const MAX_SUM_NOTES = 4;

export interface SumNote {
  amount: bigint;
  blinding: bigint;
  leafIndex: number;
}

export interface ProveSumParams {
  prover: ProverPort; // proving backend (Node / browser WASM / delegated)
  artifacts: CircuitArtifacts; // proof_of_sum wasm + zkey
  spendSk: bigint; // owner of all the notes (root orgSpendId)
  assetId: bigint;
  claimedTotal: bigint; // the exact total being disclosed (the only revealed figure)
  root: bigint; // a recent pool Merkle root the paths fold to
  tree: MerkleTreeMirror; // pool tree mirror, to build the Merkle paths
  notes: SumNote[]; // owned notes (≤ MAX_SUM_NOTES) summing to claimedTotal
  context?: bigint; // optional auditor/scope binding nonce
}

/** Build the witness and generate a proof-of-sum (exact disclose-total). */
export async function proveSum(params: ProveSumParams): Promise<ProveResult> {
  if (params.notes.length > MAX_SUM_NOTES) {
    throw new Error(`proof-of-sum supports at most ${MAX_SUM_NOTES} notes`);
  }
  // Fail fast off-circuit: the circuit enforces sum === claimedTotal, so a
  // mismatch would just fail to prove — surface it as a clear error instead.
  const declared = params.notes.reduce((s, n) => s + n.amount, 0n);
  if (declared !== params.claimedTotal) {
    throw new Error(
      `claimedTotal (${params.claimedTotal}) must equal the sum of the provided notes (${declared})`,
    );
  }
  const amount: bigint[] = [];
  const blinding: bigint[] = [];
  const pathIndices: bigint[] = [];
  const pathElements: bigint[][] = [];
  for (let i = 0; i < MAX_SUM_NOTES; i++) {
    const n = params.notes[i];
    if (n) {
      const path = params.tree.path(n.leafIndex);
      amount.push(n.amount);
      blinding.push(n.blinding);
      pathIndices.push(path.pathIndices);
      pathElements.push(path.pathElements);
    } else {
      // Padding: amount 0 disables this slot's Merkle-root check in-circuit.
      amount.push(0n);
      blinding.push(0n);
      pathIndices.push(0n);
      pathElements.push(new Array<bigint>(params.tree.levels).fill(0n));
    }
  }
  const witness = toWitnessInput({
    root: params.root,
    claimedTotal: params.claimedTotal,
    assetId: params.assetId,
    context: params.context ?? 0n,
    orgSpendId: params.spendSk,
    amount,
    blinding,
    pathIndices,
    pathElements,
  });
  return params.prover.prove(params.artifacts, witness);
}

export interface ProveSumOrgParams {
  prover: ProverPort; // proving backend
  artifacts: CircuitArtifacts; // proof_of_sum_org wasm + zkey
  orgMemberRoot: bigint; // the org's member-set root (private)
  threshold: bigint; // M (private)
  akGroup: bigint; // the secret group key (private)
  assetId: bigint;
  claimedTotal: bigint; // exact treasury total being disclosed (only revealed figure)
  root: bigint; // a recent pool Merkle root the paths fold to
  tree: MerkleTreeMirror; // pool tree mirror, to build the Merkle paths
  notes: SumNote[]; // owned ORG notes (≤ MAX_SUM_NOTES) summing to claimedTotal
  context?: bigint; // optional auditor/scope binding nonce
}

/**
 * ORG proof-of-sum: prove the M-of-N treasury (owner = orgRecipientPk(memberRoot,
 * threshold, akGroupPub(akGroup))) owns notes summing to EXACTLY `claimedTotal`,
 * revealing only the total. The disclosure proves OWNER KNOWLEDGE (the org key
 * preimage) — not a spend — so no member signatures are needed.
 */
export async function proveSumOrg(params: ProveSumOrgParams): Promise<ProveResult> {
  if (params.notes.length > MAX_SUM_NOTES) {
    throw new Error(`org proof-of-sum supports at most ${MAX_SUM_NOTES} notes`);
  }
  const declared = params.notes.reduce((s, n) => s + n.amount, 0n);
  if (declared !== params.claimedTotal) {
    throw new Error(
      `claimedTotal (${params.claimedTotal}) must equal the sum of the provided org notes (${declared})`,
    );
  }
  const amount: bigint[] = [];
  const blinding: bigint[] = [];
  const pathIndices: bigint[] = [];
  const pathElements: bigint[][] = [];
  for (let i = 0; i < MAX_SUM_NOTES; i++) {
    const n = params.notes[i];
    if (n) {
      const path = params.tree.path(n.leafIndex);
      amount.push(n.amount);
      blinding.push(n.blinding);
      pathIndices.push(path.pathIndices);
      pathElements.push(path.pathElements);
    } else {
      amount.push(0n);
      blinding.push(0n);
      pathIndices.push(0n);
      pathElements.push(new Array<bigint>(params.tree.levels).fill(0n));
    }
  }
  const witness = toWitnessInput({
    root: params.root,
    claimedTotal: params.claimedTotal,
    assetId: params.assetId,
    context: params.context ?? 0n,
    orgMemberRoot: params.orgMemberRoot,
    threshold: params.threshold,
    akGroup: params.akGroup,
    amount,
    blinding,
    pathIndices,
    pathElements,
  });
  return params.prover.prove(params.artifacts, witness);
}

/** Verify a proof-of-sum locally against its snarkjs verification key. */
export async function verifySumLocal(
  vk: unknown,
  publicSignals: string[],
  proof: ProveResult["proof"],
): Promise<boolean> {
  return verifyLocal(vk, publicSignals, proof);
}
