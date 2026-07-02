import { afterEach, describe, expect, it } from "vitest";
import { compress, merkleZeros } from "../src/crypto/poseidon2.js";
import { MerkleTreeMirror } from "../src/merkle.js";
import {
  appendPoolWitnessesFromFrontier,
  collectEvents,
  reconstructPoolWitnessFromKnownSuffix,
  type PoolStorageFrontier,
  type RpcEvent,
} from "../src/scanner.js";

// collectEvents talks to Soroban RPC via the global `fetch`; mock it with a
// queue of canned JSON-RPC envelopes so the two most failure-prone branches —
// the retention-aged-out restart and the multi-page drain — get unit coverage
// (previously only exercised indirectly by live-testnet e2e).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function queueFetch(responses: Array<{ status?: number; body: unknown }>): void {
  let i = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { status: r.status ?? 200, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
}

const ev = (ledger: number, tag: string): RpcEvent => ({
  ledger,
  txHash: tag,
  topic: ["topic"],
  value: "value",
});

// The RPC cursor encodes the ledger in the high 32 bits (see cursorLedger()).
const cur = (ledger: number) => `${(BigInt(ledger) << 32n).toString()}-0`;

function storageFrontier(levels: number, leaves: bigint[]): PoolStorageFrontier {
  const zeroes = merkleZeros(levels);
  const filledSubtrees = zeroes.slice(0, levels);
  let root = zeroes[levels];
  for (let nextIndex = 0; nextIndex < leaves.length; nextIndex++) {
    let current = leaves[nextIndex];
    let cursor = nextIndex;
    for (let level = 0; level < levels; level++) {
      if ((cursor & 1) === 0) {
        filledSubtrees[level] = current;
        current = compress(current, zeroes[level]);
      } else {
        current = compress(filledSubtrees[level], current);
      }
      cursor >>= 1;
    }
    root = current;
  }
  return { nextIndex: leaves.length, root, filledSubtrees, zeroes: zeroes.slice(0, levels) };
}

describe("collectEvents pagination", () => {
  it("restarts from the oldest retained ledger on a range error", async () => {
    queueFetch([
      { body: { error: { message: "startLedger before retention window: 1234 - 5678" } } },
      { body: { result: { events: [ev(1300, "a")], latestLedger: 5678 } } },
    ]);
    const out = await collectEvents("http://rpc", ["C"], 5);
    expect(out.map((e) => e.txHash)).toEqual(["a"]);
  });

  it("concatenates cursor-linked pages and stops at latestLedger", async () => {
    queueFetch([
      { body: { result: { events: [ev(100, "a")], cursor: cur(100), latestLedger: 5678 } } },
      // cursor ledger (6000) >= latestLedger (5678) ⇒ drained, stop.
      { body: { result: { events: [ev(200, "b")], cursor: cur(6000), latestLedger: 5678 } } },
    ]);
    const out = await collectEvents("http://rpc", ["C"], 1);
    expect(out.map((e) => e.txHash)).toEqual(["a", "b"]);
  });

  it("throws (does not silently truncate) on a mid-pagination error", async () => {
    queueFetch([
      { body: { result: { events: [ev(100, "a")], cursor: cur(100), latestLedger: 5678 } } },
      { body: { error: { message: "boom" } } },
    ]);
    await expect(collectEvents("http://rpc", ["C"], 1)).rejects.toThrow(/pagination/);
  });
});

describe("pool suffix witness reconstruction", () => {
  it("builds witnesses for newly appended leaves from the pre-submit frontier", () => {
    const levels = 10;
    const before = Array.from({ length: 391 }, (_, i) => BigInt(i + 10_000));
    const appended = [99_001n, 99_002n];
    const afterFirst = new MerkleTreeMirror(levels);
    for (const leaf of [...before, appended[0]]) afterFirst.insert(leaf);
    const mirror = new MerkleTreeMirror(levels);
    for (const leaf of [...before, ...appended]) mirror.insert(leaf);

    const witnesses = appendPoolWitnessesFromFrontier(
      levels,
      storageFrontier(levels, before),
      appended,
    );

    expect(witnesses.map((w) => w.leafIndex)).toEqual([391, 392]);
    expect(witnesses[0].root).toBe(afterFirst.root());
    expect(witnesses[0].pathElements).toEqual(afterFirst.path(391).pathElements);
    expect(witnesses[1].root).toBe(mirror.root());
    expect(witnesses[1].pathElements).toEqual(mirror.path(392).pathElements);
  });

  it("builds a witness for a retained recent leaf when older RPC events aged out", () => {
    const levels = 10;
    const leaves = Array.from({ length: 393 }, (_, i) => BigInt(i + 10_000));
    const mirror = new MerkleTreeMirror(levels);
    for (const leaf of leaves) mirror.insert(leaf);

    const knownLeaves = leaves.slice(363).map((commitment, offset) => ({
      leafIndex: 363 + offset,
      commitment,
    }));
    const witness = reconstructPoolWitnessFromKnownSuffix(
      levels,
      leaves[391],
      391,
      knownLeaves,
      storageFrontier(levels, leaves),
    );

    expect(witness.root).toBe(mirror.root());
    expect(witness.pathElements).toEqual(mirror.path(391).pathElements);
  });

  it("fails closed when the retained suffix cannot supply the sibling path", () => {
    const levels = 10;
    const leaves = Array.from({ length: 393 }, (_, i) => BigInt(i + 10_000));
    expect(() =>
      reconstructPoolWitnessFromKnownSuffix(
        levels,
        leaves[391],
        391,
        [
          { leafIndex: 391, commitment: leaves[391] },
          { leafIndex: 392, commitment: leaves[392] },
        ],
        storageFrontier(levels, leaves),
      ),
    ).toThrow(/missing sibling subtree/);
  });
});
