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
  mvkRegistryLeaf,
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
if (!HAVE_ARTIFACTS) {
  // Make the skip LOUD: a green run with these tests skipped does NOT mean the ZK
  // works. `pnpm test:zk` hard-fails on this via scripts/check-artifacts.mjs.
  console.warn(
    "\n⚠️  ZK PROVING ARTIFACTS ABSENT — shield/joinsplit/unshield/sum proving tests are SKIPPED.\n" +
      "    A passing run here does NOT exercise any real proof. Build them first:\n" +
      "      bash scripts/build-artifacts.sh   (compile from source)\n" +
      "      bash scripts/fetch-artifacts.sh   (download the exact deployed-matching artifacts)\n" +
      "    Or run `pnpm test:zk` to FAIL when artifacts are missing.\n",
  );
}

const ASSET_ID = 123456789n;

describe.skipIf(!HAVE_ARTIFACTS)("shield circuit", () => {
  const depositor = 987654321n;
  const aspBlinding = 55n;

  function buildShieldWitness() {
    const aspTree = new MerkleTreeMirror(16);
    const leafIdx = aspTree.insert(aspLeaf(depositor, aspBlinding));
    const path = aspTree.path(leafIdx);
    // Authorized-MVK registry: register mvkPub 777 so the note's tag is valid.
    const mvkTree = new MerkleTreeMirror(16);
    const mvkKeyMeta = 0n;
    const mvkIdx = mvkTree.insert(mvkRegistryLeaf(777n, mvkKeyMeta));
    const mvkPath = mvkTree.path(mvkIdx);
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
      registeredMvkRoot: mvkTree.root(),
      recipientPk: note.recipientPk,
      blinding: note.blinding,
      mvkPub: 777n,
      aspBlinding,
      aspPathElements: path.pathElements,
      aspPathIndices: path.pathIndices,
      mvkKeyMeta,
      mvkPathElements: mvkPath.pathElements,
      mvkPathIndices: mvkPath.pathIndices,
    };
  }

  it("proves and locally verifies a valid shield", async () => {
    const w = buildShieldWitness();
    const res = await prove(art("shield"), toWitnessInput(w));
    expect(res.sorobanPublics.length).toBe(7);
    // public order: [commitment, amount, assetId, depositor, aspRoot, mvkTag, registeredMvkRoot]
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

  it("rejects a note bound to an UNREGISTERED MVK (the audit P0)", async () => {
    const w = buildShieldWitness();
    // Bind the note to mvkPub 888 (with a matching tag) — but 888 is NOT in the
    // authorized-MVK registry, so registry membership fails. Pre-fix this would
    // have proven, yielding a permanently-unauditable note.
    const bad = { ...w, mvkPub: 888n, mvkTag: mvkTag(888n, w.blinding) };
    await expect(prove(art("shield"), toWitnessInput(bad))).rejects.toThrow();
  }, 60_000);

  it("rejects the all-zeros MVK key", async () => {
    const w = buildShieldWitness();
    const bad = { ...w, mvkPub: 0n, mvkTag: mvkTag(0n, w.blinding) };
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

  // Authorized-MVK registry: both outputs use mvkPub 777, so one registered leaf.
  const mvkTree = new MerkleTreeMirror(16);
  const mvkP = mvkTree.path(mvkTree.insert(mvkRegistryLeaf(777n, 0n)));

  const witness = {
    root: tree.root(),
    assetId: ASSET_ID,
    inputNullifier: [noteNullifier(31337n, BigInt(idx)), noteNullifier(99999n, 12345n)],
    outputCommitment: [noteCommitment(out0), noteCommitment(out1)],
    fee,
    extDataHash: 0xabcdefn,
    mvkTag: [mvkTag(777n, out0.blinding), mvkTag(777n, out1.blinding)],
    registeredMvkRoot: mvkTree.root(),
    mvkKeyMeta: [0n, 0n],
    mvkPathElements: [mvkP.pathElements, mvkP.pathElements],
    mvkPathIndices: [mvkP.pathIndices, mvkP.pathIndices],
    inAmount: [inNote.amount, 0n],
    inOrgSpendId: [31337n, 99999n],
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
    expect(res.sorobanPublics.length).toBe(11);
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
    const mvkT = new MerkleTreeMirror(16);
    const mvkPp = mvkT.path(mvkT.insert(mvkRegistryLeaf(1n, 0n)));

    const witness = {
      root: tree.root(),
      assetId: ASSET_ID,
      inputNullifier: [noteNullifier(2468n, BigInt(idx)), noteNullifier(1357n, 7n)],
      outputCommitment: [noteCommitment(out0), noteCommitment(out1)],
      fee: 0n,
      extDataHash: 0x55n,
      mvkTag: [mvkTag(1n, out0.blinding), mvkTag(1n, out1.blinding)],
      registeredMvkRoot: mvkT.root(),
      mvkKeyMeta: [0n, 0n],
      mvkPathElements: [mvkPp.pathElements, mvkPp.pathElements],
      mvkPathIndices: [mvkPp.pathIndices, mvkPp.pathIndices],
      inAmount: [OOR, 0n],
      inOrgSpendId: [2468n, 1357n],
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
    const mvkTree = new MerkleTreeMirror(16);
    const mvkKeyMeta = 0n;
    const mvkPath = mvkTree.path(mvkTree.insert(mvkRegistryLeaf(888n, mvkKeyMeta)));
    return {
      root: tree.root(),
      assetId: ASSET_ID,
      nullifier: noteNullifier(5151n, BigInt(idx)),
      publicAmount: 2_500_000n,
      changeCommitment: noteCommitment(change),
      extDataHash: 0x1234n,
      aspNonMembershipRoot: 0n, // empty deny-set
      changeMvkTag: mvkTag(888n, change.blinding),
      registeredMvkRoot: mvkTree.root(),
      inAmount: inNote.amount,
      inOrgSpendId: 5151n,
      inBlinding: inNote.blinding,
      inPathIndices: path.pathIndices,
      inPathElements: path.pathElements,
      changeAmount: change.amount,
      changePubkey: change.recipientPk,
      changeBlinding: change.blinding,
      changeMvkPub: 888n,
      mvkKeyMeta,
      mvkPathElements: mvkPath.pathElements,
      mvkPathIndices: mvkPath.pathIndices,
      smtSiblings: new Array<bigint>(16).fill(0n),
      smtOldKey: 0n,
      smtOldValue: 0n,
      smtIsOld0: 1n,
    };
  }

  it("proves a withdraw with change + proof-of-innocence vs empty deny-set", async () => {
    const w = buildUnshieldWitness();
    const res = await prove(art("unshield"), toWitnessInput(w));
    expect(res.sorobanPublics.length).toBe(9);
    expect(await verifyLocal(vk("unshield"), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("rejects conservation violations (in != public + change)", async () => {
    const w = buildUnshieldWitness();
    const bad = { ...w, publicAmount: w.publicAmount + 1n };
    await expect(prove(art("unshield"), toWitnessInput(bad))).rejects.toThrow();
  }, 120_000);
});

describe.skipIf(!HAVE_ARTIFACTS)("proof_of_sum circuit (disclose-total)", () => {
  // Three real notes summing to 6,000,000, owned by one spend identity, plus a
  // padding slot — the ZK replacement for the old plaintext decrypt-and-sum.
  function fixture() {
    const tree = new MerkleTreeMirror(32);
    const kp = deriveKeypair(13579n);
    const amounts = [2_000_000n, 3_000_000n, 1_000_000n];
    const blindings = [111n, 222n, 333n];
    const notes = amounts.map((amount, i) => ({
      amount,
      recipientPk: kp.publicKey,
      blinding: blindings[i],
      assetId: ASSET_ID,
    }));
    // Insert ALL notes first, THEN read paths against the final tree (an early
    // leaf's siblings change as later leaves are added).
    const idxs = notes.map((n) => tree.insert(noteCommitment(n)));
    const paths = idxs.map((idx) => tree.path(idx));
    const ZERO_PATH = new Array<bigint>(32).fill(0n);
    return {
      tree,
      orgSpendId: 13579n,
      amount: [...amounts, 0n], // pad to nNotes=4
      blinding: [...blindings, 0n],
      pathIndices: [...paths.map((p) => p.pathIndices), 0n],
      pathElements: [...paths.map((p) => p.pathElements), ZERO_PATH],
    };
  }

  it("proves the exact total (6,000,000) and reveals only that figure", async () => {
    const f = fixture();
    const witness = {
      root: f.tree.root(),
      claimedTotal: 6_000_000n,
      assetId: ASSET_ID,
      context: 0xc0ffeen,
      orgSpendId: f.orgSpendId,
      amount: f.amount,
      blinding: f.blinding,
      pathIndices: f.pathIndices,
      pathElements: f.pathElements,
    };
    const res = await prove(art("proof_of_sum"), toWitnessInput(witness));
    expect(res.sorobanPublics.length).toBe(4);
    // public order: [root, claimedTotal, assetId, context] — only the total is revealed.
    expect(BigInt(res.publicSignals[1])).toBe(6_000_000n);
    expect(await verifyLocal(vk("proof_of_sum"), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("cannot lie about the sum (wrong claimedTotal does not prove)", async () => {
    const f = fixture();
    const bad = {
      root: f.tree.root(),
      claimedTotal: 5_000_000n, // real sum is 6,000,000
      assetId: ASSET_ID,
      context: 1n,
      orgSpendId: f.orgSpendId,
      amount: f.amount,
      blinding: f.blinding,
      pathIndices: f.pathIndices,
      pathElements: f.pathElements,
    };
    await expect(prove(art("proof_of_sum"), toWitnessInput(bad))).rejects.toThrow();
  }, 120_000);
});
