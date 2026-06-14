/**
 * Proof-of-balance / proof-of-funds.
 *
 * Generates a zero-knowledge proof that the holder owns notes in the pool tree
 * summing to at least `threshold`, without revealing the amounts, the count, or
 * which leaves they are. Public inputs: [root, threshold, assetId, context].
 *
 * The circuit (circuits/groth16/proof_of_balance.circom) supports up to
 * MAX_NOTES inputs under one spend key; unused slots are padded with amount 0
 * (their Merkle-root check is disabled in-circuit).
 */

import { MerkleTreeMirror } from "./merkle.js";
import { prove, verifyLocal, toWitnessInput, type CircuitArtifacts, type ProveResult } from "./prover.js";

/** Maximum notes a single proof-of-balance can aggregate (circuit-fixed). */
export const MAX_BALANCE_NOTES = 4;

export interface BalanceNote {
  amount: bigint;
  blinding: bigint;
  leafIndex: number;
}

export interface ProveBalanceParams {
  artifacts: CircuitArtifacts; // proof_of_balance wasm + zkey
  spendSk: bigint; // owner of all the notes
  assetId: bigint;
  threshold: bigint; // the minimum balance being proven
  root: bigint; // a recent pool Merkle root the paths fold to
  tree: MerkleTreeMirror; // pool tree mirror, to build the Merkle paths
  notes: BalanceNote[]; // owned notes (≤ MAX_BALANCE_NOTES) summing ≥ threshold
  context?: bigint; // optional request/recipient binding nonce
}

/**
 * Greedily pick up to MAX_BALANCE_NOTES notes (largest first) that together
 * cover `threshold`. Returns null if even the largest MAX_BALANCE_NOTES can't.
 * Pure + exported for reuse/testing.
 */
export function selectNotesForBalance<T extends { amount: bigint }>(
  notes: T[],
  threshold: bigint,
): T[] | null {
  const desc = [...notes].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const chosen: T[] = [];
  let sum = 0n;
  for (const n of desc) {
    if (sum >= threshold) break;
    if (chosen.length >= MAX_BALANCE_NOTES) break;
    chosen.push(n);
    sum += n.amount;
  }
  return sum >= threshold ? chosen : null;
}

/** Build the witness and generate a proof-of-balance. */
export async function proveBalance(params: ProveBalanceParams): Promise<ProveResult> {
  if (params.notes.length > MAX_BALANCE_NOTES) {
    throw new Error(`proof-of-balance supports at most ${MAX_BALANCE_NOTES} notes`);
  }
  const amount: bigint[] = [];
  const blinding: bigint[] = [];
  const pathIndices: bigint[] = [];
  const pathElements: bigint[][] = [];
  for (let i = 0; i < MAX_BALANCE_NOTES; i++) {
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
    threshold: params.threshold,
    assetId: params.assetId,
    context: params.context ?? 0n,
    spendSk: params.spendSk,
    amount,
    blinding,
    pathIndices,
    pathElements,
  });
  return prove(params.artifacts, witness);
}

/** Verify a proof-of-balance locally against its snarkjs verification key. */
export async function verifyBalanceLocal(
  vk: unknown,
  publicSignals: string[],
  proof: ProveResult["proof"],
): Promise<boolean> {
  return verifyLocal(vk, publicSignals, proof);
}
