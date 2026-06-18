/**
 * zkLogin Tier-1 — OAuth verify → unique-human credential. The JWT verification
 * boundary is injected (real impl checks Google's JWKS); here we fake the claims
 * to exercise the tier mapping, audience check, and nullifier domain-separation.
 */
import { describe, it, expect } from "vitest";
import { ZkLoginProvider, type JwtVerifyFn } from "../src/zklogin.js";
import { AssuranceTier } from "../src/index.js";

const AUD = "benzo-client-id";
const claims: JwtVerifyFn = async () => ({ sub: "user-123", aud: AUD, iss: "https://accounts.google.com" });

describe("ZkLoginProvider (Tier-1, passport-free)", () => {
  it("verifies an OAuth token → UNIQUE_HUMAN with a domain-separated nullifier", async () => {
    const p = new ZkLoginProvider(claims, AUD, (raw) => (raw % 1000n) + 1n);
    const v = await p.verify("jwt");
    expect(v.tier).toBe(AssuranceTier.UNIQUE_HUMAN);
    expect(v.ofacClear).toBe(true);
    expect(typeof v.nullifier).toBe("bigint");
    expect(v.nullifier).toBeGreaterThan(0n);
  });

  it("is deterministic per (iss, sub) — same identity → same nullifier", async () => {
    const p = new ZkLoginProvider(claims, AUD);
    const a = await p.verify("jwt");
    const b = await p.verify("jwt2"); // same claims
    expect(a.nullifier).toBe(b.nullifier);
  });

  it("rejects a token issued for a different audience", async () => {
    const wrongAud: JwtVerifyFn = async () => ({ sub: "u", aud: "someone-else", iss: "https://accounts.google.com" });
    await expect(new ZkLoginProvider(wrongAud, AUD).verify("jwt")).rejects.toThrow(/audience mismatch/);
  });
});
