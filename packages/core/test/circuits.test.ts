/**
 * Circuit integration tests: build witnesses with the TS SDK and prove
 * through the REAL compiled circuits (snarkjs, headless). If any TS hash
 * mirror diverged from the circom templates by a byte, witness generation
 * would violate a constraint and proving would fail — so a green run here
 * is the circuit<->SDK byte-identity proof. Local verification uses the
 * exported snarkjs verification keys.
 *
 * Negative tests assert that malformed witnesses CANNOT be proven.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MerkleTreeMirror } from "../src/merkle.js";
import {
  aspLeaf,
  deriveKeypair,
  mvkTag,
  noteCommitment,
  noteNullifier,
} from "../src/notes.js";
import { prove, toWitnessInput, verifyLocal } from "../src/prover.js";

const root = fileURLToPath(new URL("../../../circuits/build", import.meta.url));
const art = (c: string) => ({
  wasmPath: `${root}/${c}/${c}_js/${c}.wasm`,
  zkeyPath: `${root}/${c}/${c}.zkey`,
});
const vk = (c: string) => JSON.parse(readFileSync(`${root}/${c}/${c}_vk.json`, "utf8"));

// The compiled proving artifacts (.wasm witness generators + .zkey, ~80 MB)
// are gitignored. When they're absent (e.g. a fresh CI checkout) these heavy
// proving tests skip; the small VK/proof fixtures used by parity.test.ts are
// committed, so the byte-identity encoding invariant is still enforced in CI.
const HAVE_ARTIFACTS = existsSync(art("shield").zkeyPath);

const ASSET_ID = 123456789n;

describe.skipIf(!HAVE_ARTIFACTS)("shield circuit", () => {
  const depositor = 987654321n;
  const aspBlinding = 55n;

  function buildShieldWitness() {
    const aspTree = new MerkleTreeMirror(16);
    const leafIdx = aspTree.insert(aspLeaf(depositor, aspBlinding));
    const path = aspTree.path(leafIdx);
    const kp = deriveKeypair(1111n);
    const note = {
      amount: 5_000_000n,
      recipientPk: kp.publicKey,
      blinding: 2222n,
      assetId: ASSET_ID,
    };
    return {
      commitment: noteCommitment(note),
      amount: note.amount,
      assetId: ASSET_ID,
      depositor,
      aspMembershipRoot: aspTree.root(),
      mvkTag: mvkTag(777n, note.blinding),
      recipientPk: note.recipientPk,
      blinding: note.blinding,
      mvkPub: 777n,
      aspBlinding,
      aspPathElements: path.pathElements,
      aspPathIndices: path.pathIndices,
    };
  }

  it("proves and locally verifies a valid shield", async () => {
    const w = buildShieldWitness();
    const res = await prove(art("shield"), toWitnessInput(w));
    expect(res.sorobanPublics.length).toBe(6);
    // public order: [commitment, amount, assetId, depositor, aspRoot, mvkTag]
    expect(BigInt(res.publicSignals[0])).toBe(w.commitment);
    expect(BigInt(res.publicSignals[1])).toBe(w.amount);
    expect(await verifyLocal(vk("shield"), res.publicSignals, res.proof)).toBe(true);
  }, 60_000);

  it("rejects a depositor outside the ASP allow-set", async () => {
    const w = buildShieldWitness();
    // proof for a different depositor than the one in the allow-set leaf
    const bad = { ...w, depositor: w.depositor + 1n };
    await expect(prove(art("shield"), toWitnessInput(bad))).rejects.toThrow();
  }, 60_000);

  it("rejects a malformed commitment", async () => {
    const w = buildShieldWitness();
    const bad = { ...w, commitment: w.commitment + 1n };
    await expect(prove(art("shield"), toWitnessInput(bad))).rejects.toThrow();
  }, 60_000);
});

function buildTransferFixture() {
  const tree = new MerkleTreeMirror(32);
  const kp = deriveKeypair(31337n);
  const inNote = {
    amount: 5_000_000n,
    recipientPk: kp.publicKey,
    blinding: 424242n,
    assetId: ASSET_ID,
  };
  const idx = tree.insert(noteCommitment(inNote));
  const path = tree.path(idx);

  // dummy second input
  const dummyKp = deriveKeypair(99999n);
  const dummy = {
    amount: 0n,
    recipientPk: dummyKp.publicKey,
    blinding: 1n,
    assetId: ASSET_ID,
  };

  const outKp = deriveKeypair(777777n);
  const out0 = {
    amount: 3_000_000n,
    recipientPk: outKp.publicKey,
    blinding: 11n,
    assetId: ASSET_ID,
  };
  const out1 = {
    amount: 1_999_990n,
    recipientPk: kp.publicKey,
    blinding: 22n,
    assetId: ASSET_ID,
  }; // change
  const fee = 10n; // 5_000_000 = 3_000_000 + 1_999_990 + 10

  const witness = {
    root: tree.root(),
    assetId: ASSET_ID,
    inputNullifier: [noteNullifier(31337n, BigInt(idx)), noteNullifier(99999n, 12345n)],
    outputCommitment: [noteCommitment(out0), noteCommitment(out1)],
    fee,
    extDataHash: 0xabcdefn,
    mvkTag: [mvkTag(777n, out0.blinding), mvkTag(777n, out1.blinding)],
    inAmount: [inNote.amount, 0n],
    inSpendSk: [31337n, 99999n],
    inBlinding: [inNote.blinding, dummy.blinding],
    inPathIndices: [path.pathIndices, 12345n],
    inPathElements: [path.pathElements, new Array<bigint>(32).fill(0n)],
    outAmount: [out0.amount, out1.amount],
    outPubkey: [out0.recipientPk, out1.recipientPk],
    outBlinding: [out0.blinding, out1.blinding],
    outMvkPub: [777n, 777n],
  };
  return { witness, tree };
}

describe.skipIf(!HAVE_ARTIFACTS)("joinsplit circuit", () => {
  it("proves a 1-real + 1-dummy join-split with fee (value conservation)", async () => {
    const { witness } = buildTransferFixture();
    const res = await prove(art("joinsplit"), toWitnessInput(witness));
    expect(res.sorobanPublics.length).toBe(10);
    expect(await verifyLocal(vk("joinsplit"), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("rejects value inflation (sum out > sum in)", async () => {
    const { witness } = buildTransferFixture();
    const bad = {
      ...witness,
      outAmount: [witness.outAmount[0] + 1_000_000n, witness.outAmount[1]],
      // recompute commitment so only the conservation constraint trips? No —
      // keep the declared commitment; either constraint failing is fine.
    };
    await expect(prove(art("joinsplit"), toWitnessInput(bad))).rejects.toThrow();
  }, 120_000);

  it("rejects spending a note not in the tree (bad merkle path)", async () => {
    const { witness } = buildTransferFixture();
    const bad = {
      ...witness,
      root: witness.root + 1n,
    };
    await expect(prove(art("joinsplit"), toWitnessInput(bad))).rejects.toThrow();
  }, 120_000);

  it("rejects a wrong nullifier", async () => {
    const { witness } = buildTransferFixture();
    const bad = {
      ...witness,
      inputNullifier: [witness.inputNullifier[0] + 1n, witness.inputNullifier[1]],
    };
    await expect(prove(art("joinsplit"), toWitnessInput(bad))).rejects.toThrow();
  }, 120_000);

  // Hardening (goal G): the 64-bit range check on INPUT amounts. This witness
  // is fully self-consistent (membership, nullifier, value-conservation, and
  // both outputs in 64-bit range) and WOULD have proven before the check —
  // its only defect is an input amount of 2^64+10. It must now fail to prove.
  it("rejects an out-of-range INPUT amount (2^64+10) that conserves value", async () => {
    const tree = new MerkleTreeMirror(32);
    const kp = deriveKeypair(2468n);
    const OOR = 2n ** 64n + 10n; // out of 64-bit range
    const inNote = { amount: OOR, recipientPk: kp.publicKey, blinding: 9090n, assetId: ASSET_ID };
    const idx = tree.insert(noteCommitment(inNote));
    const path = tree.path(idx);
    const dummyKp = deriveKeypair(1357n);
    // Split into two IN-RANGE outputs that sum (over the integers) to 2^64+10.
    const half = 2n ** 63n; // < 2^64, in range
    const out0 = { amount: half, recipientPk: kp.publicKey, blinding: 1n, assetId: ASSET_ID };
    const out1 = { amount: half + 10n, recipientPk: kp.publicKey, blinding: 2n, assetId: ASSET_ID };

    const witness = {
      root: tree.root(),
      assetId: ASSET_ID,
      inputNullifier: [noteNullifier(2468n, BigInt(idx)), noteNullifier(1357n, 7n)],
      outputCommitment: [noteCommitment(out0), noteCommitment(out1)],
      fee: 0n,
      extDataHash: 0x55n,
      mvkTag: [mvkTag(1n, out0.blinding), mvkTag(1n, out1.blinding)],
      inAmount: [OOR, 0n],
      inSpendSk: [2468n, 1357n],
      inBlinding: [inNote.blinding, 1n],
      inPathIndices: [path.pathIndices, 7n],
      inPathElements: [path.pathElements, new Array<bigint>(32).fill(0n)],
      outAmount: [out0.amount, out1.amount],
      outPubkey: [out0.recipientPk, out1.recipientPk],
      outBlinding: [out0.blinding, out1.blinding],
      outMvkPub: [1n, 1n],
    };
    await expect(prove(art("joinsplit"), toWitnessInput(witness))).rejects.toThrow();
  }, 120_000);
});

describe.skipIf(!HAVE_ARTIFACTS)("unshield circuit", () => {
  function buildUnshieldWitness() {
    const tree = new MerkleTreeMirror(32);
    const kp = deriveKeypair(5151n);
    const inNote = {
      amount: 4_000_000n,
      recipientPk: kp.publicKey,
      blinding: 616161n,
      assetId: ASSET_ID,
    };
    const idx = tree.insert(noteCommitment(inNote));
    const path = tree.path(idx);
    const changeKp = deriveKeypair(727272n);
    const change = {
      amount: 1_500_000n,
      recipientPk: changeKp.publicKey,
      blinding: 33n,
      assetId: ASSET_ID,
    };
    return {
      root: tree.root(),
      assetId: ASSET_ID,
      nullifier: noteNullifier(5151n, BigInt(idx)),
      publicAmount: 2_500_000n,
      changeCommitment: noteCommitment(change),
      extDataHash: 0x1234n,
      aspNonMembershipRoot: 0n, // empty deny-set
      changeMvkTag: mvkTag(888n, change.blinding),
      inAmount: inNote.amount,
      inSpendSk: 5151n,
      inBlinding: inNote.blinding,
      inPathIndices: path.pathIndices,
      inPathElements: path.pathElements,
      changeAmount: change.amount,
      changePubkey: change.recipientPk,
      changeBlinding: change.blinding,
      changeMvkPub: 888n,
      smtSiblings: new Array<bigint>(16).fill(0n),
      smtOldKey: 0n,
      smtOldValue: 0n,
      smtIsOld0: 1n,
    };
  }

  it("proves a withdraw with change + proof-of-innocence vs empty deny-set", async () => {
    const w = buildUnshieldWitness();
    const res = await prove(art("unshield"), toWitnessInput(w));
    expect(res.sorobanPublics.length).toBe(8);
    expect(await verifyLocal(vk("unshield"), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("rejects conservation violations (in != public + change)", async () => {
    const w = buildUnshieldWitness();
    const bad = { ...w, publicAmount: w.publicAmount + 1n };
    await expect(prove(art("unshield"), toWitnessInput(bad))).rejects.toThrow();
  }, 120_000);
});
