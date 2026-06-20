/**
 * Off-chain mirror of the on-chain authorized-MVK registry
 * (`contracts/mvk_registry`). The shield/transfer/unshield circuits prove the
 * note's MVK is a member of this registry under a recent `registeredMvkRoot`
 * (leaf = `mvkRegistryLeaf(mvkPub, keyMeta)`, the circuit's
 * `BenzoMvkRegistryLeaf`, domain 0x08). To build that witness the SDK needs the
 * registry root + a Merkle path to the MVK's leaf — exactly what this mirror
 * provides, the same way `MerkleTreeMirror` mirrors the pool and ASP trees.
 *
 * Depth is pinned to the circuit's `mvkLevels` (16). The on-chain registry is
 * deployed with `levels = 16` to match.
 *
 * Two ways to use it:
 *  - **Synced** (production): construct once, replay the registry's
 *    `MvkRegistered` events via `register()` in chain order so `root()` tracks
 *    the deployed contract; then `pathFor(mvkPub)` yields a path valid on-chain.
 *  - **Single-leaf** (current default, pending the registry deployment + the
 *    pool.rs `registeredMvkRoot` validation + a re-ceremony for the new VKs):
 *    `MvkRegistryMirror.singleLeaf(mvkPub)` builds a one-entry registry so the
 *    proof is well-formed. See docs/ZK-AUDIT-AND-STANDARDS.md B.4.
 */
import { MerkleTreeMirror, type MerklePath } from "./merkle.js";
import { mvkRegistryLeaf } from "./notes.js";

/** Circuit `mvkLevels` — the on-chain registry must be deployed with this depth. */
export const MVK_REGISTRY_DEPTH = 16;

/** Default `keyMeta` (packs org/scope/expiry/epoch; a single 0 field for the MVP). */
export const DEFAULT_MVK_KEY_META = 0n;

export class MvkRegistryMirror {
  private readonly tree: MerkleTreeMirror;
  /** mvkPub → leaf index, so a repeated registration is a no-op (mirrors the
   *  contract's `MvkSeen` dedup that rejects a second leaf for the same key). */
  private readonly index = new Map<bigint, number>();

  constructor(depth: number = MVK_REGISTRY_DEPTH) {
    this.tree = new MerkleTreeMirror(depth);
  }

  /**
   * Replay prior on-chain state: reset and insert `leaves` (raw leaf values from
   * `MvkRegistered` events, in index order) so the mirror's root tracks a
   * registry that already holds entries. Subsequent `register()` calls append
   * after them — exactly as the contract does — so the root stays in lockstep.
   * Prior leaves carry no `mvkPub→index` mapping (we only need paths for keys
   * this process registers); `pathFor` on a synced-but-not-registered key throws.
   */
  syncLeaves(leaves: bigint[]): void {
    this.tree.leaves = [];
    this.index.clear();
    for (const leaf of leaves) this.tree.insert(leaf);
  }

  /**
   * Sync ALL on-chain leaves AND record the index of a key WE own, wherever it
   * sits (not just the tail). This is the robust replacement for
   * `syncLeaves(prefix) + register(ours)`: it reproduces the exact on-chain root
   * for any registry state and still yields `pathFor(ours)`. Use when another
   * party may have registered after us (e.g. after claiming an ephemeral link
   * account, whose MVK becomes the new tail).
   */
  syncWithOwnedKey(leaves: bigint[], mvkPub: bigint, keyMeta: bigint = DEFAULT_MVK_KEY_META): number {
    this.syncLeaves(leaves);
    const idx = leaves.indexOf(mvkRegistryLeaf(mvkPub, keyMeta));
    if (idx < 0) throw new Error("MvkRegistryMirror: owned key not present in synced leaves");
    this.index.set(mvkPub, idx);
    return idx;
  }

  /** Register an MVK (idempotent per `mvkPub`); returns its leaf index. */
  register(mvkPub: bigint, keyMeta: bigint = DEFAULT_MVK_KEY_META): number {
    if (mvkPub === 0n) throw new Error("MvkRegistryMirror: mvkPub must be nonzero");
    const existing = this.index.get(mvkPub);
    if (existing !== undefined) return existing;
    const idx = this.tree.insert(mvkRegistryLeaf(mvkPub, keyMeta));
    this.index.set(mvkPub, idx);
    return idx;
  }

  isRegistered(mvkPub: bigint): boolean {
    return this.index.has(mvkPub);
  }

  /** Current registry root — the witness's `registeredMvkRoot`. */
  root(): bigint {
    return this.tree.root();
  }

  /** Merkle path to a registered MVK's leaf (throws if not registered). */
  pathFor(mvkPub: bigint): MerklePath {
    const idx = this.index.get(mvkPub);
    if (idx === undefined) throw new Error("MvkRegistryMirror: MVK not registered");
    return this.tree.path(idx);
  }

  /**
   * A one-entry registry holding just `mvkPub` — the well-formed-proof stand-in
   * used until the registry is deployed and synced. Equivalent to `new
   * MvkRegistryMirror()` + a single `register`.
   */
  static singleLeaf(mvkPub: bigint, keyMeta: bigint = DEFAULT_MVK_KEY_META): MvkRegistryMirror {
    const m = new MvkRegistryMirror();
    m.register(mvkPub, keyMeta);
    return m;
  }
}
