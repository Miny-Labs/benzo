/**
 * Off-chain mirror of the on-chain incremental Merkle tree
 * (contracts/merkle): same Poseidon2 compression, same zero table, so paths
 * computed here fold to exactly the on-chain roots.
 *
 * Incremental, stored-node design (the pattern every production mixer uses —
 * Tornado/Railgun/NethermindEth's stellar-private-payments): each level keeps
 * its filled nodes, so `insert` updates only the O(levels) spine, `root` is
 * O(1), and `path` is O(levels). The previous version recomputed the whole
 * tree on every `root()`/`path()` call (O(n·levels) each), which dominated
 * proving/sync once the pool held more than a handful of notes. Roots and paths
 * are byte-identical to that naive algorithm (asserted in merkle.test.ts).
 */

import { compress, merkleZeros } from "./crypto/poseidon2.js";

export interface MerklePath {
  pathElements: bigint[];
  /** index of the leaf == path indices encoded as one integer */
  pathIndices: bigint;
}

export class MerkleTreeMirror {
  readonly levels: number;
  readonly zeros: bigint[];
  /** nodes[0] = leaves; nodes[l] = level l; the root lives at nodes[levels][0]. */
  private nodes: bigint[][];

  constructor(levels: number) {
    this.levels = levels;
    this.zeros = merkleZeros(levels);
    this.nodes = Array.from({ length: levels + 1 }, () => []);
  }

  /** The leaf list, in insertion order. */
  get leaves(): bigint[] {
    return this.nodes[0];
  }

  /** Replace all leaves (clears the tree, then re-inserts in order). */
  set leaves(next: bigint[]) {
    this.nodes = Array.from({ length: this.levels + 1 }, () => []);
    for (const leaf of next) this.insert(leaf);
  }

  insert(leaf: bigint): number {
    const index = this.nodes[0].length;
    this.nodes[0].push(leaf);
    // Walk the spine from leaf to root, recomputing only the affected parent at
    // each level (its sibling is the stored node, or the level's zero filler).
    let idx = index;
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const parent = idx >> 1;
      const leftIdx = parent << 1;
      const left = this.nodes[lvl][leftIdx];
      const right =
        leftIdx + 1 < this.nodes[lvl].length ? this.nodes[lvl][leftIdx + 1] : this.zeros[lvl];
      this.nodes[lvl + 1][parent] = compress(left, right);
      idx = parent;
    }
    return index;
  }

  root(): bigint {
    if (this.nodes[0].length === 0) return this.zeros[this.levels];
    return this.nodes[this.levels][0];
  }

  path(index: number): MerklePath {
    if (index < 0 || index >= this.nodes[0].length) {
      throw new Error(`leaf index ${index} out of range`);
    }
    const pathElements: bigint[] = [];
    let idx = index;
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const sibling = idx ^ 1;
      pathElements.push(
        sibling < this.nodes[lvl].length ? this.nodes[lvl][sibling] : this.zeros[lvl],
      );
      idx >>= 1;
    }
    return { pathElements, pathIndices: BigInt(index) };
  }
}
