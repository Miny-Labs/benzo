import { describe, it, expect } from "vitest";
import { accountFromClaimSecret } from "./account.js";

const secret = new Uint8Array(32).fill(7);

describe("accountFromClaimSecret — app-scoped key domains", () => {
  it("is deterministic per (secret, app)", () => {
    const a = accountFromClaimSecret(secret, "consumer");
    const b = accountFromClaimSecret(secret, "consumer");
    expect(a.spendSk).toBe(b.spendSk);
    expect([...a.mvkSecret]).toEqual([...b.mvkSecret]);
  });

  it("consumer keeps the legacy domain (default arg === explicit 'consumer')", () => {
    const legacy = accountFromClaimSecret(secret);
    const explicit = accountFromClaimSecret(secret, "consumer");
    expect(legacy.spendSk).toBe(explicit.spendSk);
    expect([...legacy.mvkSecret]).toEqual([...explicit.mvkSecret]);
    expect([...legacy.viewSecret]).toEqual([...explicit.viewSecret]);
  });

  it("a consumer claim secret CANNOT reconstruct a business account", () => {
    const consumer = accountFromClaimSecret(secret, "consumer");
    const business = accountFromClaimSecret(secret, "business");
    expect(business.spendSk).not.toBe(consumer.spendSk);
    expect([...business.mvkSecret]).not.toEqual([...consumer.mvkSecret]);
    expect([...business.viewSecret]).not.toEqual([...consumer.viewSecret]);
  });
});
