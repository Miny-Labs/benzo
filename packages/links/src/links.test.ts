import { describe, it, expect } from "vitest";
import { encodeBenzoLink, parseBenzoLink, type BenzoLink } from "./index.js";

const cases: BenzoLink[] = [
  { type: "claim", secret: "abc123def", amount: "10.5", asset: "USDC" },
  { type: "claim", secret: "deadbeef" },
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
  },
  { type: "handle", handle: "asha" },
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

  it("rejects junk", () => {
    expect(parseBenzoLink("https://example.com/foo")).toBeNull();
    expect(parseBenzoLink("benzo://claim")).toBeNull(); // no secret fragment
  });
});
