/**
 * Verifier-parity oracle.
 *
 * The on-chain Groth16 verifier reads BN254 points in a precise byte layout
 * (G1 = x‖y = 64B; G2 = x.c1‖x.c0‖y.c1‖y.c0 = 128B, i.e. snarkjs's [c0,c1]
 * REORDERED to c1‖c0). A silent mismatch here makes every proof fail (or, worse,
 * a malformed VK). These tests pin the encoding produced from the *real* deployed
 * circuit verification keys against that exact layout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vkToSoroban, proofToSoroban, publicsToSoroban, g1Hex, g2Hex, feHex } from "../src/crypto/groth16.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(`${repo}/${p}`, "utf8"));
const fe = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");

describe("verifier-parity oracle: snarkjs → Soroban encoding", () => {
  for (const c of ["shield", "joinsplit", "unshield"]) {
    it(`${c} VK encodes to the exact Soroban byte shape`, () => {
      const vk = read(`circuits/build/${c}/${c}_vk.json`);
      const s = vkToSoroban(vk);
      expect(s.alpha).toHaveLength(128); // G1 = 64 bytes
      for (const g2 of [s.beta, s.gamma, s.delta]) expect(g2).toHaveLength(256); // G2 = 128 bytes
      expect(s.ic.length).toBe(vk.IC.length);
      expect(s.ic.length).toBe(Number(vk.nPublic) + 1); // IC = nPublic + 1
      for (const h of [s.alpha, s.beta, s.gamma, s.delta, ...s.ic]) expect(h).toMatch(/^[0-9a-f]+$/);
    });
  }

  it("a proof encodes to the exact Soroban byte shape", () => {
    // Synthetic-but-well-formed Groth16 proof (affine points: G1 z=1, G2 z=[1,0]).
    // Self-contained on purpose — no longer depends on the cut "trivial" circuit's
    // build artifacts; it exercises the same proofToSoroban byte-shape encoding.
    const proof = {
      pi_a: ["1", "2", "1"],
      pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
      pi_c: ["5", "6", "1"],
      protocol: "groth16",
      curve: "bn128",
    };
    const s = proofToSoroban(proof as never);
    expect(s.a).toHaveLength(128);
    expect(s.b).toHaveLength(256);
    expect(s.c).toHaveLength(128);
    for (const h of [s.a, s.b, s.c]) expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("public inputs are decimal U256 (Bn254Fr CLI form)", () => {
    expect(publicsToSoroban(["42", 43n, "0x2a"])).toEqual(["42", "43", "42"]);
  });

  it("G2 applies the snarkjs [c0,c1] → Soroban c1‖c0 reordering", () => {
    // x=[c0=1,c1=2], y=[c0=3,c1=4] ⇒ expect 2,1,4,3
    expect(g2Hex([["1", "2"], ["3", "4"], ["1", "0"]])).toBe(fe(2) + fe(1) + fe(4) + fe(3));
  });

  it("rejects non-affine points (catches silent encoding bugs)", () => {
    expect(() => g1Hex(["1", "2", "2"])).toThrow(); // z != 1
    expect(() => g2Hex([["1", "2"], ["3", "4"], ["1", "1"]])).toThrow(); // z != [1,0]
  });

  it("feHex fails loud on >32-byte and negative field elements (no silent byte shift)", () => {
    expect(feHex(0n)).toBe("0".repeat(64));
    expect(feHex(2n ** 256n - 1n)).toBe("f".repeat(64)); // exactly 32 bytes is fine
    expect(() => feHex(2n ** 256n)).toThrow(/exceeds 32 bytes/); // 65 hex chars
    expect(() => feHex(-1n)).toThrow(/non-negative/);
  });

  it("encoders give a named error on malformed VK / proof JSON", () => {
    expect(() => vkToSoroban({ vk_alpha_1: ["1", "2", "1"] } as never)).toThrow(/missing vk_beta_2/);
    expect(() => proofToSoroban({ pi_a: ["1", "2", "1"] } as never)).toThrow(/missing pi_b/);
  });
});
