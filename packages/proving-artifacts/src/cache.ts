/**
 * `ArtifactCache` — get-or-fetch for circuit proving artifacts, backed by any
 * async byte store (IndexedDB in the browser via @benzo/wallet's KVStore, an
 * in-memory map in tests). Download once → cached forever per circuit+vkHash;
 * a VK bump changes the key and the old entry is simply never read again.
 *
 * On a cache MISS it fetches, verifies the SHA-256 content hash (download
 * integrity — see manifest.ts on why this is not a trust anchor), then stores.
 * On a cache HIT it returns the bytes with no network. This is the layer that
 * turns "download a 22 MB zkey before every send" into "download once in the
 * background during onboarding."
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { ArtifactRef } from "./manifest.js";

/** Minimal async byte store (structurally compatible with @benzo/wallet KVStore). */
export interface ByteStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
}

/** The loaded artifacts, ready to hand to a WasmProver. */
export interface LoadedArtifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
}

export class ArtifactCache {
  constructor(
    private readonly store: ByteStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private key(circuit: string, vkHash: string, kind: "wasm" | "zkey"): string {
    return `benzo/artifact/${circuit}/${vkHash}/${kind}`;
  }

  /** Return both artifacts for a circuit, fetching+verifying+caching as needed. */
  async getOrFetch(ref: ArtifactRef): Promise<LoadedArtifacts> {
    const [wasm, zkey] = await Promise.all([
      this.loadOne(ref, "wasm", ref.wasmUrl, ref.wasmHash),
      this.loadOne(ref, "zkey", ref.zkeyUrl, ref.zkeyHash),
    ]);
    return { wasm, zkey };
  }

  /** Is this circuit's artifact already cached (no network needed)? */
  async isCached(ref: ArtifactRef): Promise<boolean> {
    const [w, z] = await Promise.all([
      this.store.get(this.key(ref.circuit, ref.vkHash, "wasm")),
      this.store.get(this.key(ref.circuit, ref.vkHash, "zkey")),
    ]);
    return w !== null && z !== null;
  }

  /**
   * Warm the cache for a set of circuits without blocking on any single one —
   * call during onboarding so the heavy zkeys are local by first payment.
   * Individual failures are swallowed (best-effort prefetch); a real fetch on
   * the hot path will surface the error then.
   */
  async prefetch(refs: ArtifactRef[]): Promise<void> {
    await Promise.all(
      refs.map((r) => this.getOrFetch(r).then(() => undefined, () => undefined)),
    );
  }

  private async loadOne(
    ref: ArtifactRef,
    kind: "wasm" | "zkey",
    url: string,
    expectedHash: string,
  ): Promise<Uint8Array> {
    const k = this.key(ref.circuit, ref.vkHash, kind);
    const cached = await this.store.get(k);
    if (cached) return cached;

    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`artifact fetch ${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (expectedHash) {
      const got = bytesToHex(sha256(bytes));
      if (got !== expectedHash) {
        throw new Error(
          `artifact integrity: ${kind} hash mismatch for "${ref.circuit}" ` +
            `(got ${got.slice(0, 16)}…, want ${expectedHash.slice(0, 16)}…)`,
        );
      }
    }
    await this.store.set(k, bytes);
    return bytes;
  }
}
