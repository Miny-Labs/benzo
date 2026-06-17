/**
 * ArtifactCache — get-or-fetch with SHA-256 integrity, cache-once semantics,
 * and best-effort prefetch. No network: a fake fetch + in-memory store.
 */
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { ArtifactCache, type ByteStore } from "../src/cache.js";
import type { ArtifactRef } from "../src/manifest.js";

class MemStore implements ByteStore {
  map = new Map<string, Uint8Array>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: Uint8Array) {
    this.map.set(k, v.slice());
  }
}

const zkeyBytes = new Uint8Array([1, 2, 3, 4, 5]);
const wasmBytes = new Uint8Array([9, 8, 7]);

function refFor(): ArtifactRef {
  return {
    circuit: "shield",
    vkHash: "vk_abc",
    zkeyUrl: "https://cdn.example/shield.zkey",
    wasmUrl: "https://cdn.example/shield.wasm",
    zkeyHash: bytesToHex(sha256(zkeyBytes)),
    wasmHash: bytesToHex(sha256(wasmBytes)),
    sizeBytes: zkeyBytes.length,
  };
}

function fakeFetch(counter: { n: number }, override?: Partial<Record<string, Uint8Array>>) {
  return (async (url: string) => {
    counter.n++;
    const body = url.endsWith(".zkey")
      ? override?.zkey ?? zkeyBytes
      : override?.wasm ?? wasmBytes;
    return {
      ok: true,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }) as unknown as typeof fetch;
}

describe("ArtifactCache", () => {
  it("fetches + verifies + stores on miss, then serves from cache (no network)", async () => {
    const store = new MemStore();
    const counter = { n: 0 };
    const cache = new ArtifactCache(store, fakeFetch(counter));
    const ref = refFor();

    const first = await cache.getOrFetch(ref);
    expect(first.zkey).toEqual(zkeyBytes);
    expect(first.wasm).toEqual(wasmBytes);
    expect(counter.n).toBe(2); // one zkey + one wasm fetch

    const second = await cache.getOrFetch(ref);
    expect(second.zkey).toEqual(zkeyBytes);
    expect(counter.n).toBe(2); // cache hit — no new fetch
    expect(await cache.isCached(ref)).toBe(true);
  });

  it("rejects a corrupt download (hash mismatch)", async () => {
    const store = new MemStore();
    const counter = { n: 0 };
    // server returns wrong zkey bytes
    const cache = new ArtifactCache(store, fakeFetch(counter, { zkey: new Uint8Array([0, 0, 0]) }));
    await expect(cache.getOrFetch(refFor())).rejects.toThrow(/integrity/);
  });

  it("re-fetches when vkHash changes (auto-invalidation)", async () => {
    const store = new MemStore();
    const counter = { n: 0 };
    const cache = new ArtifactCache(store, fakeFetch(counter));
    await cache.getOrFetch(refFor());
    expect(counter.n).toBe(2);
    const bumped = { ...refFor(), vkHash: "vk_v2" };
    await cache.getOrFetch(bumped);
    expect(counter.n).toBe(4); // different key → fetched again
  });

  it("prefetch is best-effort (a bad ref doesn't throw)", async () => {
    const store = new MemStore();
    const counter = { n: 0 };
    const badFetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const cache = new ArtifactCache(store, badFetch);
    await expect(cache.prefetch([refFor()])).resolves.toBeUndefined();
  });
});
