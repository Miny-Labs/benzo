import { describe, it, expect } from "vitest";
import { MerkleTreeMirror } from "../src/merkle.js";
import { compress, merkleZeros } from "../src/crypto/poseidon2.js";

/**
 * Naive reference (the previous full-recompute algorithm). The incremental
 * MerkleTreeMirror must produce byte-identical roots and paths to this, because
 * the contracts cross-check the mirror root against the on-chain root.
 */
function naiveRoot(leaves: bigint[], levels: number): bigint {
  const zeros = merkleZeros(levels);
  if (leaves.length === 0) return zeros[levels];
  let nodes = [...leaves];
  for (let lvl = 0; lvl < levels; lvl++) {
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(compress(nodes[i], i + 1 < nodes.length ? nodes[i + 1] : zeros[lvl]));
    }
    nodes = next;
  }
  return nodes[0];
}

function naivePath(leaves: bigint[], levels: number, index: number): bigint[] {
  const zeros = merkleZeros(levels);
  const out: bigint[] = [];
  let nodes = [...leaves];
  let idx = index;
  for (let lvl = 0; lvl < levels; lvl++) {
    const sib = idx ^ 1;
    out.push(sib < nodes.length ? nodes[sib] : zeros[lvl]);
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(compress(nodes[i], i + 1 < nodes.length ? nodes[i + 1] : zeros[lvl]));
    }
    nodes = next;
    idx >>= 1;
  }
  return out;
}

// deterministic pseudo-random field elements (no Math.random)
function leafAt(i: number): bigint {
  let x = BigInt(i + 1) * 0x9e3779b97f4a7c15n;
  x ^= x >> 30n;
  x *= 0xbf58476d1ce4e5b9n;
  x ^= x >> 27n;
  return x & ((1n << 200n) - 1n);
}

describe("MerkleTreeMirror (incremental) matches the naive algorithm byte-for-byte", () => {
  for (const levels of [4, 8, 16]) {
    for (const n of [0, 1, 2, 3, 5, 8, 13, 21]) {
      it(`root: levels=${levels} n=${n}`, () => {
        const t = new MerkleTreeMirror(levels);
        const leaves: bigint[] = [];
        for (let i = 0; i < n; i++) {
          const l = leafAt(i);
          leaves.push(l);
          t.insert(l);
          // root must match the naive recompute after EVERY insert
          expect(t.root()).toBe(naiveRoot(leaves, levels));
        }
        if (n === 0) expect(t.root()).toBe(naiveRoot([], levels));
      });

      it(`paths: levels=${levels} n=${n}`, () => {
        const t = new MerkleTreeMirror(levels);
        const leaves: bigint[] = [];
        for (let i = 0; i < n; i++) { const l = leafAt(i); leaves.push(l); t.insert(l); }
        for (let i = 0; i < n; i++) {
          const p = t.path(i);
          expect(p.pathIndices).toBe(BigInt(i));
          expect(p.pathElements).toEqual(naivePath(leaves, levels, i));
        }
      });
    }
  }

  it("empty tree root is the zero-root; out-of-range path throws", () => {
    const t = new MerkleTreeMirror(8);
    expect(t.root()).toBe(merkleZeros(8)[8]);
    expect(() => t.path(0)).toThrow(/out of range/);
  });

  it("the leaves setter clears and rebuilds (used by poolRebuild/aspRebuild)", () => {
    const t = new MerkleTreeMirror(8);
    t.insert(leafAt(99));
    const rebuilt = [leafAt(1), leafAt(2), leafAt(3)];
    t.leaves = rebuilt;
    expect(t.leaves).toEqual(rebuilt);
    expect(t.root()).toBe(naiveRoot(rebuilt, 8));
    t.leaves = [];
    expect(t.root()).toBe(naiveRoot([], 8));
  });
});
