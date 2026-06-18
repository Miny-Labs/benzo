/**
 * Tiered ZK identity — the non-mock gate. The proof verification boundary is the
 * real Self verifier in production; here we inject a fake result to exercise the
 * tier mapping, OFAC handling, nullifier domain-separation, and the policy.
 */
import { describe, it, expect } from "vitest";
import {
  AssuranceTier,
  meetsTier,
  tierFromSelf,
  SelfIdentityProvider,
  type SelfVerifyFn,
} from "../src/index.js";

describe("tier policy", () => {
  it("meetsTier is a >= comparison", () => {
    expect(meetsTier(AssuranceTier.VERIFIED_ID, AssuranceTier.UNIQUE_HUMAN)).toBe(true);
    expect(meetsTier(AssuranceTier.UNIQUE_HUMAN, AssuranceTier.VERIFIED_ID)).toBe(false);
    expect(meetsTier(AssuranceTier.ANONYMOUS, AssuranceTier.ANONYMOUS)).toBe(true);
  });

  it("maps Self attestation + OFAC to the right tier", () => {
    expect(tierFromSelf(1, true)).toBe(AssuranceTier.VERIFIED_ID); // passport, clean
    expect(tierFromSelf(3, true)).toBe(AssuranceTier.VERIFIED_ID); // Aadhaar, clean
    expect(tierFromSelf(1, false)).toBe(AssuranceTier.UNIQUE_HUMAN); // doc but OFAC-flagged
    expect(tierFromSelf(undefined, true)).toBe(AssuranceTier.UNIQUE_HUMAN); // humanity only
  });
});

describe("SelfIdentityProvider", () => {
  const passportResult: SelfVerifyFn = async () => ({
    isValid: true,
    attestationId: 1,
    nullifier: "42",
    ofac: [false, false, false],
    nationality: "GBR",
    olderThan: 18,
  });

  it("verifies a real-shaped Self result → VERIFIED_ID with domain-sep nullifier", async () => {
    const provider = new SelfIdentityProvider(passportResult, (raw) => raw * 1000n + 7n);
    const v = await provider.verify({ attestationId: 1, proof: {}, publicSignals: [], userContextData: "0x" });
    expect(v.tier).toBe(AssuranceTier.VERIFIED_ID);
    expect(v.ofacClear).toBe(true);
    expect(v.nullifier).toBe(42_007n); // domain-separated, not the raw Self nullifier
    expect(v.attributes?.nationality).toBe("GBR");
  });

  it("downgrades to UNIQUE_HUMAN when OFAC is flagged", async () => {
    const flagged: SelfVerifyFn = async () => ({ isValid: true, attestationId: 1, nullifier: 9n, ofac: [false, true, false] });
    const v = await new SelfIdentityProvider(flagged).verify({ attestationId: 1, proof: {}, publicSignals: [], userContextData: "" });
    expect(v.ofacClear).toBe(false);
    expect(v.tier).toBe(AssuranceTier.UNIQUE_HUMAN);
  });

  it("rejects an invalid proof", async () => {
    const invalid: SelfVerifyFn = async () => ({ isValid: false, nullifier: 0n });
    await expect(
      new SelfIdentityProvider(invalid).verify({ attestationId: 1, proof: {}, publicSignals: [], userContextData: "" }),
    ).rejects.toThrow(/not valid/);
  });
});
