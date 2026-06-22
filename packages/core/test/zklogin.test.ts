import { describe, it, expect } from "vitest";
import { accountFromOidc, oidcAddressSeed, oidcClaimSecret, zkLoginNonce } from "../src/zklogin.js";

const id = { sub: "10987654321", iss: "https://accounts.google.com", aud: "abc.apps.googleusercontent.com" };

describe("zklogin (Sui-zkLogin model, Phase 1)", () => {
  it("derives a deterministic account from the same OIDC identity", () => {
    expect(accountFromOidc(id).spendPub).toBe(accountFromOidc(id).spendPub);
  });

  it("is unlinkable: a different sub yields a different account", () => {
    expect(accountFromOidc(id).spendPub).not.toBe(accountFromOidc({ ...id, sub: "999" }).spendPub);
  });

  it("salt scopes the derivation (different salt -> different account)", () => {
    expect(accountFromOidc(id, { salt: "orgA" }).spendPub).not.toBe(accountFromOidc(id, { salt: "orgB" }).spendPub);
  });

  it("the claim secret is 32 bytes and deterministic", () => {
    const s = oidcClaimSecret(id);
    expect(s.length).toBe(32);
    expect(Buffer.from(s).toString("hex")).toBe(Buffer.from(oidcClaimSecret(id)).toString("hex"));
  });

  it("nonce binds the ephemeral key (same inputs same nonce, different key different nonce)", () => {
    expect(zkLoginNonce(123n, 10n, 7n)).toBe(zkLoginNonce(123n, 10n, 7n));
    expect(zkLoginNonce(123n, 10n, 7n)).not.toBe(zkLoginNonce(124n, 10n, 7n));
  });

  it("the address seed is stable and salt-scoped", () => {
    expect(oidcAddressSeed(id, 7n)).toBe(oidcAddressSeed(id, 7n));
    expect(oidcAddressSeed(id, 7n)).not.toBe(oidcAddressSeed(id, 8n));
  });
});
