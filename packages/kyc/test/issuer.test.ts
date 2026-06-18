/**
 * CredentialIssuer — signs a tiered KYC credential that the kyc_credential
 * circuit verifies in ZK. Here we check the signature is valid (the same
 * EdDSA-Poseidon the circuit checks), the tier is carried in credType, the
 * holder binding is preserved, and a tampered signature fails.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CredentialIssuer } from "../src/issuer.js";
import { AssuranceTier } from "../src/index.js";

// biome-ignore lint: shared across the suite
let issuer: CredentialIssuer;
beforeAll(async () => {
  // deterministic 32-byte issuer key
  issuer = await CredentialIssuer.create("03".repeat(32));
});

const HOLDER = 11595409024260843952256254417901568911939116301604943175730463763249826216782n;

describe("CredentialIssuer", () => {
  it("issues a tier-2 credential bound to the holder, with a verifiable signature", () => {
    const c = issuer.issue({ holderBinding: HOLDER, tier: AssuranceTier.VERIFIED_ID, expiry: 1_900_000_000n, serial: 7n });
    expect(c.credType).toBe(2n); // tier carried in credType
    expect(c.addressBinding).toBe(HOLDER);
    expect(c.issuerKeyId).toBe(issuer.pubkey().keyId);
    expect(issuer.verify(c)).toBe(true);
  });

  it("carries the assurance tier faithfully", () => {
    expect(issuer.issue({ holderBinding: HOLDER, tier: AssuranceTier.UNIQUE_HUMAN, expiry: 1n, serial: 1n }).credType).toBe(1n);
    expect(issuer.issue({ holderBinding: HOLDER, tier: AssuranceTier.FULL, expiry: 1n, serial: 2n }).credType).toBe(3n);
  });

  it("a tampered signature fails verification", () => {
    const c = issuer.issue({ holderBinding: HOLDER, tier: AssuranceTier.VERIFIED_ID, expiry: 1_900_000_000n, serial: 7n });
    expect(issuer.verify({ ...c, sigS: c.sigS + 1n })).toBe(false);
  });
});
