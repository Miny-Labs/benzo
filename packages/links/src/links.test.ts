import { describe, it, expect } from "vitest";
import {
  encodeBenzoLink,
  parseBenzoLink,
  assertAppScope,
  linkApp,
  WrongAppError,
  type BenzoLink,
} from "./index.js";

const cases: BenzoLink[] = [
  { type: "claim", secret: "abc123def", amount: "10.5", asset: "USDC" },
  { type: "claim", secret: "deadbeef" },
  // app-scoped + invite metadata
  { type: "claim", secret: "s3cr3t", amount: "25", asset: "USDC", app: "consumer", expiresAt: "1800000000", context: "AbCdEf0123" },
  { type: "request", to: "@asha", amount: "20", asset: "USDC", memo: "lunch" },
  { type: "request", to: "GBRMUZEL...XYZ" },
  {
    type: "request",
    to: "@asha",
    amount: "25",
    asset: "USDC",
    memo: "invoice",
    id: "12345678901234567890",
    expiry: "1800000000",
    reference: "INV-001",
    payer: "@bob",
    app: "consumer",
  },
  { type: "handle", handle: "asha" },
  { type: "handle", handle: "acme", app: "business" },
  { type: "org", orgId: "org_1", kind: "contractor", token: "hmac-tok-123", role: "member", orgName: "Acme Inc", app: "business", expiresAt: "1800000000" },
  { type: "org", orgId: "org_1", kind: "member", token: "tok2", app: "business" },
];

describe("BenzoLink round-trip", () => {
  for (const link of cases) {
    it(`scheme round-trips ${JSON.stringify(link)}`, () => {
      expect(parseBenzoLink(encodeBenzoLink(link, "scheme"))).toEqual(link);
    });
    it(`web round-trips ${JSON.stringify(link)}`, () => {
      expect(parseBenzoLink(encodeBenzoLink(link, "web"))).toEqual(link);
    });
  }

  it("keeps the claim secret only in the fragment (not the query)", () => {
    const url = encodeBenzoLink({ type: "claim", secret: "s3cr3t", amount: "1" });
    expect(url.split("#")[1]).toBe("s3cr3t");
    expect(url.split("#")[0]).not.toContain("s3cr3t");
  });

  it("keeps the org invite token only in the fragment (not the query)", () => {
    const url = encodeBenzoLink({ type: "org", orgId: "org_1", kind: "contractor", token: "hmac-tok-123" });
    expect(url.split("#")[1]).toBe("hmac-tok-123");
    expect(url.split("#")[0]).not.toContain("hmac-tok-123");
  });

  it("rejects junk", () => {
    expect(parseBenzoLink("https://example.com/foo")).toBeNull();
    expect(parseBenzoLink("benzo://claim")).toBeNull(); // no secret fragment
    expect(parseBenzoLink("benzo://org?o=org_1&kind=member")).toBeNull(); // no token
    expect(parseBenzoLink("benzo://org?kind=member#tok")).toBeNull(); // no orgId
  });
});

describe("app-scope boundary", () => {
  it("legacy (untagged) links default to consumer", () => {
    expect(linkApp({ type: "claim", secret: "x" })).toBe("consumer");
    expect(linkApp({ type: "request", to: "@a" })).toBe("consumer");
  });

  it("org links default to business", () => {
    expect(linkApp({ type: "org", orgId: "o", kind: "member", token: "t" })).toBe("business");
  });

  it("assertAppScope passes when scopes match", () => {
    expect(() => assertAppScope({ type: "claim", secret: "x", app: "consumer" }, "consumer")).not.toThrow();
    expect(() => assertAppScope({ type: "org", orgId: "o", kind: "member", token: "t" }, "business")).not.toThrow();
  });

  it("assertAppScope throws WrongAppError across the boundary (both directions)", () => {
    // business invite opened in the consumer wallet
    try {
      assertAppScope({ type: "org", orgId: "o", kind: "contractor", token: "t" }, "consumer");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WrongAppError);
      expect((e as WrongAppError).linkScope).toBe("business");
      expect((e as WrongAppError).expected).toBe("consumer");
    }
    // consumer claim opened in the business console
    expect(() => assertAppScope({ type: "claim", secret: "x", app: "consumer" }, "business")).toThrow(WrongAppError);
  });
});
