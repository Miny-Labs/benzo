/**
 * joinsplit_org — TRANSFER with in-circuit M-of-N org dual-control (stage 2).
 *
 * A copy of the live joinsplit with a per-input selector forced by the note's
 * recipient_pk: an ORG note (recipientPk = Poseidon2(memberRoot, threshold,
 * akGroupPub)) is spendable ONLY via >=threshold member EdDSA sigs over this
 * transfer's spendMessage, with a canonical unlinkable org nullifier; a CONSUMER
 * note keeps the single-key path. Public inputs are identical to the live joinsplit.
 *
 * Verified by WITNESS CALCULATION (enforces every constraint; no trusted setup):
 *  - valid: 1 org input + 1 consumer dummy  (the common org-spend shape)
 *  - valid: BOTH inputs org                  (the 2-org-input / 2^18 case)
 *  - adversarial: org input sub-threshold (1 of 2 sigs)        -> rejected
 *  - adversarial: org note spent via the consumer path (isOrg=0) -> rejected
 *  - adversarial: tampered org nullifier                        -> rejected
 *  - adversarial: value inflation                               -> rejected
 * Self-skips when the gitignored wasm is absent.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { MerkleTreeMirror } from "../src/merkle.js";
import { deriveKeypair, noteCommitment, noteNullifier, mvkTag, mvkRegistryLeaf } from "../src/notes.js";
import { hash as p2 } from "../src/crypto/poseidon2.js";

const wasm = fileURLToPath(new URL("../../../circuits/build/joinsplit_org/joinsplit_org_js/joinsplit_org.wasm", import.meta.url));
const HAVE = existsSync(wasm);
const POOL = 32, MVKL = 16, ML = 16, MAX = 3;
const ASSET = 123456789n;
// capacity-slot domains (note.circom)
const KEYPAIR = 0x03n, NK = 0x07n, NULL = 0x02n, ORG = 0x09n;

// biome-ignore lint: test-local mutable singletons
let eddsa: any, poseidon: any, F: any;
beforeAll(async () => { eddsa = await buildEddsa(); poseidon = await buildPoseidon(); F = poseidon.F; });

const akGroupPub = (akGroup: bigint) => p2([akGroup, 0n], KEYPAIR);
const orgRecipientPk = (root: bigint, threshold: bigint, akGroup: bigint) => p2([root, threshold, akGroupPub(akGroup)], ORG);
const orgNullifier = (akGroup: bigint, blinding: bigint, leafIndex: bigint) => p2([p2([akGroup, blinding], NK), leafIndex], NULL);

function member(seed: number) {
  const prv = Buffer.alloc(32, seed);
  const pub = eddsa.prv2pub(prv);
  return { prv, Ax: F.toObject(pub[0]), Ay: F.toObject(pub[1]), keyId: F.toObject(poseidon([F.toObject(pub[0]), F.toObject(pub[1])])) };
}

type InSpec =
  | { kind: "org"; amount: bigint; blinding: bigint; akGroup: bigint; signers: number[] /* enabled slot idxs */; threshold: bigint }
  | { kind: "consumer"; amount: bigint; blinding: bigint; spendSk: bigint };

/** Build a full joinsplit_org witness for two input specs (+ a fixed, conserving output set). */
function build(specs: [InSpec, InSpec], opts: { forceConsumerSpend?: boolean } = {}) {
  const members = [member(11), member(12), member(13)];
  const memberTree = new MerkleTreeMirror(ML);
  const mIdx = members.map((m) => memberTree.insert(m.keyId));
  const memberRoot = memberTree.root();

  const pool = new MerkleTreeMirror(POOL);
  // Insert input notes, capture leaf indices + the data needed for nullifiers.
  const ins = specs.map((s) => {
    if (s.kind === "org") {
      const recipientPk = orgRecipientPk(memberRoot, s.threshold, s.akGroup);
      const leafIndex = pool.insert(noteCommitment({ amount: s.amount, recipientPk, blinding: s.blinding, assetId: ASSET }));
      return { s, recipientPk, leafIndex, nullifier: orgNullifier(s.akGroup, s.blinding, BigInt(leafIndex)) };
    }
    const recipientPk = deriveKeypair(s.spendSk).publicKey;
    // amount==0 dummies aren't inserted into the tree (root check skipped); give a free index.
    const leafIndex = s.amount === 0n ? 90000 + Math.floor(Number(s.blinding % 1000n)) : pool.insert(noteCommitment({ amount: s.amount, recipientPk, blinding: s.blinding, assetId: ASSET }));
    return { s, recipientPk, leafIndex, nullifier: noteNullifier(s.spendSk, BigInt(leafIndex)) };
  });

  // Outputs: conserve value. out0 to a fresh key, out1 = change to a fresh key. fee = 10.
  const totalIn = specs[0].amount + specs[1].amount;
  const fee = 10n;
  const out0 = { amount: (totalIn - fee) / 2n, recipientPk: deriveKeypair(777777n).publicKey, blinding: 11n, assetId: ASSET };
  const out1 = { amount: totalIn - fee - (totalIn - fee) / 2n, recipientPk: deriveKeypair(888888n).publicKey, blinding: 22n, assetId: ASSET };
  const mvkTree = new MerkleTreeMirror(MVKL);
  const mvkP = mvkTree.path(mvkTree.insert(mvkRegistryLeaf(777n, 0n)));

  const inputNullifier = [ins[0].nullifier, ins[1].nullifier];
  const outputCommitment = [noteCommitment(out0), noteCommitment(out1)];

  // spendMessage = circomlib Poseidon(4)(nullifiers, commitments) — what members sign.
  const spendMessage = F.toObject(poseidon([inputNullifier[0], inputNullifier[1], outputCommitment[0], outputCommitment[1]]));
  const msgEl = F.e(spendMessage);

  // Per-input signer arrays (every slot signs; `enabled` selects which count).
  const mk = (enabledIdxs: number[]) => {
    const sigs = members.map((m) => eddsa.signPoseidon(m.prv, msgEl));
    const paths = mIdx.map((ix) => memberTree.path(ix));
    return {
      enabled: members.map((_, i) => (enabledIdxs.includes(i) ? 1n : 0n)),
      Ax: members.map((m) => m.Ax), Ay: members.map((m) => m.Ay),
      S: sigs.map((g: any) => g.S), R8x: sigs.map((g: any) => F.toObject(g.R8[0])), R8y: sigs.map((g: any) => F.toObject(g.R8[1])),
      pathElements: paths.map((p) => p.pathElements as bigint[]), pathIndices: paths.map((p) => BigInt(p.pathIndices)),
    };
  };

  const inIsOrg: bigint[] = [], orgMemberRoot: bigint[] = [], orgThreshold: bigint[] = [], akGroup: bigint[] = [];
  const mEnabled: bigint[][] = [], mAx: bigint[][] = [], mAy: bigint[][] = [], mS: bigint[][] = [], mR8x: bigint[][] = [], mR8y: bigint[][] = [];
  const mPathElements: bigint[][][] = [], mPathIndices: bigint[][] = [];
  const inAmount: bigint[] = [], inOrgSpendId: bigint[] = [], inBlinding: bigint[] = [], inPathIndices: bigint[] = [], inPathElements: bigint[][] = [];
  specs.forEach((s, tx) => {
    const isOrg = s.kind === "org" && !opts.forceConsumerSpend;
    inIsOrg.push(isOrg ? 1n : 0n);
    const sg = mk(s.kind === "org" ? s.signers : []);
    mEnabled.push(sg.enabled); mAx.push(sg.Ax); mAy.push(sg.Ay); mS.push(sg.S); mR8x.push(sg.R8x); mR8y.push(sg.R8y);
    mPathElements.push(sg.pathElements); mPathIndices.push(sg.pathIndices);
    orgMemberRoot.push(memberRoot);
    orgThreshold.push(s.kind === "org" ? s.threshold : 0n);
    akGroup.push(s.kind === "org" ? s.akGroup : 0n);
    inAmount.push(s.amount);
    inOrgSpendId.push(s.kind === "consumer" ? s.spendSk : 0n);
    inBlinding.push(s.blinding);
    inPathIndices.push(BigInt(ins[tx].leafIndex));
    const isDummy = s.amount === 0n && s.kind === "consumer";
    inPathElements.push(isDummy ? new Array<bigint>(POOL).fill(0n) : (pool.path(ins[tx].leafIndex).pathElements as bigint[]));
  });

  return {
    root: pool.root(), assetId: ASSET, inputNullifier, outputCommitment, fee,
    extDataHash: 0xabcdefn, mvkTag: [mvkTag(777n, out0.blinding), mvkTag(777n, out1.blinding)], registeredMvkRoot: mvkTree.root(),
    inAmount, inOrgSpendId, inBlinding, inPathIndices, inPathElements,
    outAmount: [out0.amount, out1.amount], outPubkey: [out0.recipientPk, out1.recipientPk], outBlinding: [out0.blinding, out1.blinding],
    outMvkPub: [777n, 777n], mvkKeyMeta: [0n, 0n], mvkPathElements: [mvkP.pathElements as bigint[], mvkP.pathElements as bigint[]], mvkPathIndices: [BigInt(mvkP.pathIndices), BigInt(mvkP.pathIndices)],
    inIsOrg, orgMemberRoot, orgThreshold, akGroup, mEnabled, mAx, mAy, mS, mR8x, mR8y, mPathElements, mPathIndices,
  };
}

let _seq = 0;
const calc = (input: Record<string, unknown>) => snarkjs.wtns.calculate(input, wasm, join(tmpdir(), `jso_${_seq++}.wtns`));

const ORG0 = (over: Partial<Extract<InSpec, { kind: "org" }>> = {}): InSpec =>
  ({ kind: "org", amount: 4_000_000n, blinding: 0xb10n, akGroup: 0x6772_70n, signers: [0, 1], threshold: 2n, ...over });
const DUMMY: InSpec = { kind: "consumer", amount: 0n, blinding: 1n, spendSk: 99999n };

describe.skipIf(!HAVE)("joinsplit_org circuit (in-circuit M-of-N dual-control transfer)", () => {
  it("valid: 1 org input (2-of-3) + 1 consumer dummy", async () => {
    await expect(calc(build([ORG0(), DUMMY]))).resolves.toBeUndefined();
  });

  it("valid: BOTH inputs are org notes (2-of-3 each) — the 2-org-input case", async () => {
    const a = ORG0({ amount: 4_000_000n, blinding: 0xa11n, akGroup: 0x6772_70n });
    const b = ORG0({ amount: 2_000_000n, blinding: 0xb22n, akGroup: 0x6772_70n });
    await expect(calc(build([a, b]))).resolves.toBeUndefined();
  });

  it("adversarial: org input with only 1 signer (sub-threshold of 2) is rejected", async () => {
    await expect(calc(build([ORG0({ signers: [0] }), DUMMY]))).rejects.toThrow();
  });

  it("adversarial: spending an org note via the consumer path (isOrg forced 0) is rejected", async () => {
    // forceConsumerSpend makes the prover try recipPk=consumerPk for an org note;
    // the committed note's recipientPk is the org hash, so the Merkle root check fails.
    await expect(calc(build([ORG0(), DUMMY], { forceConsumerSpend: true }))).rejects.toThrow();
  });

  it("adversarial: a tampered org nullifier is rejected", async () => {
    const w = build([ORG0(), DUMMY]);
    await expect(calc({ ...w, inputNullifier: [(w.inputNullifier[0] as bigint) + 1n, w.inputNullifier[1]] })).rejects.toThrow();
  });

  it("adversarial: value inflation (output > input) is rejected", async () => {
    const w = build([ORG0(), DUMMY]);
    await expect(calc({ ...w, outAmount: [(w.outAmount[0] as bigint) + 1_000_000n, w.outAmount[1]] })).rejects.toThrow();
  });
});
