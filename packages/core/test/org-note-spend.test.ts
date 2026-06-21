/**
 * Org-NOTE spend authorization (in-circuit M-of-N merge — stage 1+2 core).
 *
 * org_note_spend now proves all three legs the merged joinsplit needs:
 *  (A) M-of-N: >=threshold DISTINCT members EdDSA-signed this transfer's spendMessage.
 *  (B) ANCHOR: recipientPk == Poseidon2(orgMemberRoot, threshold, akGroupPub; 0x09).
 *      Preimage resistance forces the M-of-N path AND pins the group key akGroup.
 *  (C) NULLIFIER: nullifier == Poseidon2(Poseidon2(akGroup, blinding; 0x07), leafIndex; 0x02).
 *      Proves knowledge of the secret group key, and yields a CANONICAL, UNLINKABLE
 *      nullifier (per-note blinding => two org notes give uncorrelated nullifiers).
 *
 * The load-bearing checks: a valid M-of-N bound to the WRONG note's recipientPk is
 * rejected; a tampered nullifier is rejected; a wrong akGroup (not matching the note's
 * pinned group key) is rejected; and two notes of the same org produce DIFFERENT
 * nullifiers (no spend-graph leak). Verified by witness calculation + real Groth16
 * prove/verify + adversarial public-input forge. Self-skips when wasm/zkey are absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { MerkleTreeMirror } from "../src/merkle.js";
import { hash as poseidon2Hash } from "../src/crypto/poseidon2.js";

const buildRoot = fileURLToPath(new URL("../../../circuits/build/org_note_spend", import.meta.url));
const wasm = `${buildRoot}/org_note_spend_js/org_note_spend.wasm`;
const zkeyPath = `${buildRoot}/org_note_spend.zkey`;
const vkPath = `${buildRoot}/org_note_spend_vk.json`;
const HAVE = existsSync(wasm);
const HAVE_ZKEY = existsSync(zkeyPath);
const LEVELS = 16;
const MAX = 3;
// Capacity-slot domains — must match note.circom.
const KEYPAIR_DOMAIN = 0x03n;
const NULLIFIER_DOMAIN = 0x02n;
const NK_DOMAIN = 0x07n;
const ORG_NOTE_DOMAIN = 0x09n;

// biome-ignore lint: test-local mutable singletons
let eddsa: any, poseidon: any, F: any;
beforeAll(async () => {
  eddsa = await buildEddsa();
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

/** A member: keypair + key-id leaf (circomlib-Poseidon of the BabyJubJub pubkey). */
function member(seed: number) {
  const prv = Buffer.alloc(32, seed);
  const pub = eddsa.prv2pub(prv);
  const Ax = F.toObject(pub[0]);
  const Ay = F.toObject(pub[1]);
  return { prv, Ax, Ay, keyId: F.toObject(poseidon([Ax, Ay])) };
}

const akGroupPubOf = (akGroup: bigint) => poseidon2Hash([akGroup, 0n], KEYPAIR_DOMAIN); // BenzoKeypair
const orgRecipientPk = (root: bigint, threshold: bigint, akGroup: bigint) =>
  poseidon2Hash([root, threshold, akGroupPubOf(akGroup)], ORG_NOTE_DOMAIN); // BenzoOrgNoteIdentity
const orgNullifier = (akGroup: bigint, blinding: bigint, leafIndex: bigint) =>
  poseidon2Hash([poseidon2Hash([akGroup, blinding], NK_DOMAIN), leafIndex], NULLIFIER_DOMAIN);

type Over = { recipientPk?: bigint; nullifier?: bigint; akGroup?: bigint };

/**
 * Build the circuit input. The note's true secrets are akGroup/blinding/leafIndex;
 * `over` lets a test inject a WRONG public binding (recipientPk/nullifier) or a wrong
 * private akGroup to exercise the soundness constraints.
 */
function buildInput(
  slots: { m: ReturnType<typeof member>; enabled: number }[],
  threshold: bigint,
  over: Over = {},
) {
  const SPEND = 123_456_789n;
  const akGroup = 0x6772_6f75_70n; // "group"
  const blinding = 0x626c_696e_64n; // "blind"
  const leafIndex = 5n;
  const tree = new MerkleTreeMirror(LEVELS);
  const leafIdx = slots.map((s) => tree.insert(s.m.keyId));
  const root = tree.root();
  const msgEl = F.e(SPEND);

  const enabled: bigint[] = [], Ax: bigint[] = [], Ay: bigint[] = [], S: bigint[] = [], R8x: bigint[] = [], R8y: bigint[] = [];
  const pathElements: bigint[][] = [], pathIndices: bigint[] = [];
  for (let i = 0; i < MAX; i++) {
    const s = slots[i];
    const sig = eddsa.signPoseidon(s.m.prv, msgEl);
    const p = tree.path(leafIdx[i]);
    enabled.push(BigInt(s.enabled));
    Ax.push(s.m.Ax); Ay.push(s.m.Ay);
    S.push(sig.S); R8x.push(F.toObject(sig.R8[0])); R8y.push(F.toObject(sig.R8[1]));
    pathElements.push(p.pathElements.map((x: bigint) => x));
    pathIndices.push(BigInt(p.pathIndices));
  }
  const akUsed = over.akGroup ?? akGroup;
  return {
    orgMemberRoot: root,
    threshold,
    spendMessage: SPEND,
    recipientPk: over.recipientPk ?? orgRecipientPk(root, threshold, akGroup),
    nullifier: over.nullifier ?? orgNullifier(akUsed, blinding, leafIndex),
    akGroup: akUsed,
    blinding,
    leafIndex,
    enabled, Ax, Ay, S, R8x, R8y, pathElements, pathIndices,
  };
}

let _seq = 0;
async function calc(input: Record<string, unknown>): Promise<void> {
  await snarkjs.wtns.calculate(input, wasm, join(tmpdir(), `ons_${_seq++}.wtns`));
}

describe.skipIf(!HAVE)("org_note_spend circuit (M-of-N + recipientPk anchor + canonical nullifier)", () => {
  it("authorizes a valid 2-of-3 against the note's own recipientPk + nullifier", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    await expect(
      calc(buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n)),
    ).resolves.toBeUndefined();
  });

  it("SOUNDNESS(anchor): rejects a valid M-of-N bound to a DIFFERENT note's recipientPk", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    const wrongPk = orgRecipientPk(new MerkleTreeMirror(LEVELS).root(), 2n, 0x6772_6f75_70n); // empty-tree root
    await expect(
      calc(buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n, { recipientPk: wrongPk })),
    ).rejects.toThrow();
  });

  it("SOUNDNESS(group key): rejects a wrong akGroup that doesn't match the note's pinned group key", async () => {
    // recipientPk pins akGroupPub(akGroup); proving with a different akGroup breaks the anchor.
    const [a, b, c] = [member(11), member(12), member(13)];
    await expect(
      calc(buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n, { akGroup: 0xdead_beefn })),
    ).rejects.toThrow();
  });

  it("SOUNDNESS(nullifier): rejects a tampered nullifier (off by one)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    const base = buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n);
    await expect(calc({ ...base, nullifier: (base.nullifier as bigint) + 1n })).rejects.toThrow();
  });

  it("PRIVACY(unlinkability): two notes of the SAME org with different blinding give DIFFERENT nullifiers", () => {
    const ak = 0x6772_6f75_70n;
    const n1 = orgNullifier(ak, 0x1111n, 5n);
    const n2 = orgNullifier(ak, 0x2222n, 5n); // same group key, same leaf index, different blinding
    expect(n1).not.toBe(n2); // observer cannot correlate the two spends to one org
  });

  it("rejects sub-threshold (1 signer, threshold 2)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    await expect(
      calc(buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 0 }, { m: c, enabled: 0 }], 2n)),
    ).rejects.toThrow();
  });

  it("rejects a duplicate signer (same member counted twice)", async () => {
    const a = member(11), c = member(13);
    await expect(
      calc(buildInput([{ m: a, enabled: 1 }, { m: a, enabled: 1 }, { m: c, enabled: 0 }], 2n)),
    ).rejects.toThrow();
  });

  it.skipIf(!HAVE_ZKEY)("produces a real Groth16 proof that verifies, with recipientPk + nullifier public", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    const input = buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm, zkeyPath);
    const vk = JSON.parse(readFileSync(vkPath, "utf8"));
    expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
    // public order: [orgMemberRoot, threshold, spendMessage, recipientPk, nullifier]
    expect(BigInt(publicSignals[1])).toBe(2n);
    expect(BigInt(publicSignals[3])).toBe(input.recipientPk);
    expect(BigInt(publicSignals[4])).toBe(input.nullifier);
  }, 120_000);

  it.skipIf(!HAVE_ZKEY)("adversarial: forging recipientPk OR nullifier public input is REJECTED (fail-closed)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    const input = buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm, zkeyPath);
    const vk = JSON.parse(readFileSync(vkPath, "utf8"));
    const forgedPk = [...publicSignals];
    forgedPk[3] = (BigInt(forgedPk[3]) + 1n).toString();
    expect(await snarkjs.groth16.verify(vk, forgedPk, proof)).toBe(false);
    const forgedNull = [...publicSignals];
    forgedNull[4] = (BigInt(forgedNull[4]) + 1n).toString();
    expect(await snarkjs.groth16.verify(vk, forgedNull, proof)).toBe(false);
  }, 120_000);
});
