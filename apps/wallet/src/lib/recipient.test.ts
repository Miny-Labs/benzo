import { describe, expect, it } from "vitest";
import { classifyRecipientInput, encodeRecipient, decodeRecipient } from "./recipient";
import { type BenzoRecipient } from "@benzo/core";

const VALID_STELLAR = "GBRMUZELYDNXSBYF5KOLLSV4XLQYNZJQNLXQ3HTFCWNRIBS3I6EUBCMP";

describe("recipient classification", () => {
  it("classifies Stellar addresses", () => {
    expect(classifyRecipientInput(VALID_STELLAR)).toBe("address");
    expect(classifyRecipientInput("  " + VALID_STELLAR + "  ")).toBe("address");
    // Invalid Stellar address but looks like one
    expect(classifyRecipientInput("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe("invite");
  });

  it("classifies bzr_ receive codes", () => {
    const rec: BenzoRecipient = {
      spendPub: 12345n,
      viewPub: new Uint8Array([1, 2, 3]),
      label: "Test",
    };
    const code = encodeRecipient(rec);
    expect(classifyRecipientInput(code)).toBe("private");
    expect(classifyRecipientInput("bzr_invalidcode")).toBe("invite");
  });

  it("classifies other inputs as invite", () => {
    expect(classifyRecipientInput("alice")).toBe("invite");
    expect(classifyRecipientInput("")).toBe("invite");
  });

  it("roundtrips encode and decode", () => {
    const rec: BenzoRecipient = {
      spendPub: 9876543210n,
      viewPub: new Uint8Array(Array.from({ length: 32 }, (_, i) => i)),
      mvkScalar: 123n,
      label: "Contractor",
    };
    const code = encodeRecipient(rec);
    const decoded = decodeRecipient(code);
    expect(decoded).not.toBeNull();
    expect(decoded?.spendPub).toBe(rec.spendPub);
    expect(decoded?.viewPub).toEqual(rec.viewPub);
    expect(decoded?.mvkScalar).toBe(rec.mvkScalar);
    expect(decoded?.label).toBe(rec.label);
  });
});
