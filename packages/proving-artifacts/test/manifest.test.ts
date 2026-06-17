/** getRef — lookup with a clear error on a missing circuit. */
import { describe, it, expect } from "vitest";
import { getRef, type ArtifactManifest } from "../src/manifest.js";

const manifest: ArtifactManifest = {
  generatedAt: "2026-06-17T00:00:00Z",
  circuits: {
    shield: {
      circuit: "shield",
      vkHash: "vk1",
      zkeyUrl: "u/shield.zkey",
      wasmUrl: "u/shield.wasm",
      zkeyHash: "h1",
      wasmHash: "h2",
      sizeBytes: 6840111,
    },
  },
};

describe("getRef", () => {
  it("returns the ref for a known circuit", () => {
    expect(getRef(manifest, "shield").sizeBytes).toBe(6840111);
  });
  it("throws a helpful error for an unknown circuit", () => {
    expect(() => getRef(manifest, "joinsplit")).toThrow(/no artifact for circuit "joinsplit"/);
  });
});
