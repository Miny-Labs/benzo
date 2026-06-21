/**
 * In-circuit M-of-N org spend-authorization circuit test. Builds real member
 * EdDSA-over-BabyJubJub signatures (circomlibjs) over a shared spendMessage, a
 * member Merkle tree, and asserts the security properties by WITNESS CALCULATION
 * (which enforces every constraint — no trusted setup needed): a valid 2-of-3
 * authorizes; sub-threshold (1 of required 2) and a duplicate signer (same member
 * twice) both FAIL. Self-skips when the gitignored circuit wasm is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { MerkleTreeMirror } from "../src/merkle.js";

const buildRoot = fileURLToPath(new URL("../../../circuits/build/org_spend_auth", import.meta.url));
const wasm = `${buildRoot}/org_spend_auth_js/org_spend_auth.wasm`;
const zkeyPath = `${buildRoot}/org_spend_auth.zkey`;
const vkPath = `${buildRoot}/org_spend_auth_vk.json`;
const HAVE = existsSync(wasm);
const HAVE_ZKEY = existsSync(zkeyPath);
const LEVELS = 16;
const MAX = 3;

// biome-ignore lint: test-local mutable singletons
let eddsa: any, poseidon: any, F: any;
beforeAll(async () => {
  eddsa = await buildEddsa();
  poseidon = await buildPoseidon();
  F = poseidon.F;
});
const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));

/** A member: keypair + key-id leaf. */
function member(seed: number) {
  const prv = Buffer.alloc(32, seed);
  const pub = eddsa.prv2pub(prv);
  const Ax = F.toObject(pub[0]);
  const Ay = F.toObject(pub[1]);
  return { prv, Ax, Ay, keyId: H([Ax, Ay]) };
}

/** Assemble the circuit input from a chosen set of (member, enabled) slots. */
function buildInput(slots: { m: ReturnType<typeof member>; enabled: number }[], threshold: bigint) {
  const SPEND = 123_456_789n;
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
  return {
    orgMemberRoot: root, threshold, spendMessage: SPEND, authTag: H([SPEND, root]),
    enabled, Ax, Ay, S, R8x, R8y, pathElements, pathIndices,
  };
}

async function calc(input: Record<string, unknown>): Promise<void> {
  await snarkjs.wtns.calculate(input, wasm, join(tmpdir(), `osa_${Math.random().toString(36).slice(2)}.wtns`));
}

describe.skipIf(!HAVE)("org_spend_auth circuit (in-circuit M-of-N)", () => {
  it("authorizes a valid 2-of-3 (two distinct members signed)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    await expect(calc(buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n))).resolves.toBeUndefined();
  });

  it("rejects sub-threshold (1 signer, threshold 2)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    await expect(calc(buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 0 }, { m: c, enabled: 0 }], 2n))).rejects.toThrow();
  });

  it("rejects a duplicate signer (same member counted twice)", async () => {
    const a = member(11), c = member(13);
    // slots 0 and 1 are the SAME member a — distinctness must reject it
    await expect(calc(buildInput([{ m: a, enabled: 1 }, { m: a, enabled: 1 }, { m: c, enabled: 0 }], 2n))).rejects.toThrow();
  });

  it.skipIf(!HAVE_ZKEY)("produces a real Groth16 proof that verifies (end-to-end)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    const input = buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm, zkeyPath);
    const vk = JSON.parse(readFileSync(vkPath, "utf8"));
    expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
    // public order: [orgMemberRoot, threshold, spendMessage, authTag]
    expect(BigInt(publicSignals[1])).toBe(2n); // threshold
    expect(BigInt(publicSignals[2])).toBe(123_456_789n); // spendMessage
  }, 120_000);

  it.skipIf(!HAVE_ZKEY)("adversarial: a tampered proof / public input is REJECTED (fail-closed)", async () => {
    const [a, b, c] = [member(11), member(12), member(13)];
    const input = buildInput([{ m: a, enabled: 1 }, { m: b, enabled: 1 }, { m: c, enabled: 0 }], 2n);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm, zkeyPath);
    const vk = JSON.parse(readFileSync(vkPath, "utf8"));
    // forge the spendMessage public input (replay the proof for a different transfer)
    const forged = [...publicSignals];
    forged[2] = (BigInt(forged[2]) + 1n).toString();
    expect(await snarkjs.groth16.verify(vk, forged, proof)).toBe(false);
    // forge the threshold downward
    const forged2 = [...publicSignals];
    forged2[1] = "1";
    expect(await snarkjs.groth16.verify(vk, forged2, proof)).toBe(false);
  }, 120_000);
});
