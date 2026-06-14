/**
 * Proof-of-balance circuit tests. Proves ownership of notes summing >= a public
 * threshold without revealing amounts. Heavy proving tests self-skip when the
 * gitignored artifacts are absent (CI); the pure selector test always runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { MerkleTreeMirror } from "../src/merkle.js";
import { deriveKeypair, noteCommitment } from "../src/notes.js";
import { proveBalance, verifyBalanceLocal, selectNotesForBalance } from "../src/balance.js";

const root = fileURLToPath(new URL("../../../circuits/build", import.meta.url));
const artifacts = {
  wasmPath: `${root}/proof_of_balance/proof_of_balance_js/proof_of_balance.wasm`,
  zkeyPath: `${root}/proof_of_balance/proof_of_balance.zkey`,
};
const vk = () => JSON.parse(readFileSync(`${root}/proof_of_balance/proof_of_balance_vk.json`, "utf8"));
const HAVE = existsSync(artifacts.zkeyPath);

const ASSET = 123456789n;

function fixture() {
  const spendSk = 31337n;
  const pk = deriveKeypair(spendSk).publicKey;
  const tree = new MerkleTreeMirror(32);
  const notes = [
    { amount: 3_000_000n, blinding: 11n },
    { amount: 2_000_000n, blinding: 22n },
  ].map((n) => {
    const leafIndex = tree.insert(
      noteCommitment({ amount: n.amount, recipientPk: pk, blinding: n.blinding, assetId: ASSET }),
    );
    return { amount: n.amount, blinding: n.blinding, leafIndex };
  });
  return { spendSk, tree, notes }; // total 5,000,000
}

describe.skipIf(!HAVE)("proof-of-balance circuit", () => {
  it("proves notes summing >= threshold and verifies", async () => {
    const { spendSk, tree, notes } = fixture();
    const res = await proveBalance({
      artifacts, spendSk, assetId: ASSET, threshold: 5_000_000n, root: tree.root(), tree, notes,
    });
    expect(res.publicSignals.length).toBe(4); // root, threshold, assetId, context
    expect(await verifyBalanceLocal(vk(), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("proves a lower threshold with one note (the rest padded)", async () => {
    const { spendSk, tree, notes } = fixture();
    const res = await proveBalance({
      artifacts, spendSk, assetId: ASSET, threshold: 2_500_000n, root: tree.root(), tree, notes: [notes[0]],
    });
    expect(await verifyBalanceLocal(vk(), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("cannot prove a threshold above the owned balance", async () => {
    const { spendSk, tree, notes } = fixture(); // total 5,000,000
    await expect(
      proveBalance({ artifacts, spendSk, assetId: ASSET, threshold: 6_000_000n, root: tree.root(), tree, notes }),
    ).rejects.toThrow();
  }, 120_000);
});

describe("selectNotesForBalance (pure)", () => {
  it("picks largest-first to cover the threshold", () => {
    const notes = [{ amount: 1n }, { amount: 5n }, { amount: 3n }];
    expect(selectNotesForBalance(notes, 7n)?.map((n) => n.amount)).toEqual([5n, 3n]);
  });
  it("returns null when the balance can't cover it (incl. the 4-note cap)", () => {
    expect(selectNotesForBalance([{ amount: 1n }, { amount: 2n }], 100n)).toBeNull();
    const five = [1n, 1n, 1n, 1n, 1n].map((amount) => ({ amount }));
    expect(selectNotesForBalance(five, 5n)).toBeNull(); // capped at 4 → sum 4 < 5
  });
});
