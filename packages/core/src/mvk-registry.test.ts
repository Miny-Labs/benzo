import { describe, it, expect } from "vitest";
import { MvkRegistryMirror } from "./mvk-registry.js";
import { mvkRegistryLeaf } from "./notes.js";

describe("MvkRegistryMirror.syncWithOwnedKey", () => {
  // reference: a registry built by sequential registration
  const ref = new MvkRegistryMirror();
  ref.register(11n);
  ref.register(22n);
  ref.register(33n);
  const leaves = [11n, 22n, 33n].map((k) => mvkRegistryLeaf(k, 0n));

  it("reproduces the on-chain root for any owned-key position", () => {
    for (const k of [11n, 22n, 33n]) {
      const m = new MvkRegistryMirror();
      m.syncWithOwnedKey(leaves, k);
      expect(m.root()).toBe(ref.root());
    }
  });

  it("yields a valid path for an owned key that is NOT the tail (the claim bug)", () => {
    const m = new MvkRegistryMirror();
    m.syncWithOwnedKey(leaves, 22n); // middle key — used to throw 'MVK not registered'
    expect(() => m.pathFor(22n)).not.toThrow();
    expect(m.pathFor(22n)).toEqual(ref.pathFor(22n));
  });

  it("throws if the owned key isn't in the synced leaves", () => {
    const m = new MvkRegistryMirror();
    expect(() => m.syncWithOwnedKey(leaves, 99n)).toThrow(/not present/);
  });
});
