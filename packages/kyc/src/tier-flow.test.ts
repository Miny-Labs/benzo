import { describe, it, expect } from "vitest";
import { AssuranceTier, tierForFlow, tierLabel, tierGapMessage, meetsTier } from "./index.js";

describe("tierForFlow — action → required tier", () => {
  it("free actions need no identity (T0)", () => {
    expect(tierForFlow("view")).toBe(AssuranceTier.ANONYMOUS);
    expect(tierForFlow("receive")).toBe(AssuranceTier.ANONYMOUS);
    expect(tierForFlow("proveBalance")).toBe(AssuranceTier.ANONYMOUS);
  });

  it("sending / invites need a unique human (T1)", () => {
    expect(tierForFlow("sendSmall")).toBe(AssuranceTier.UNIQUE_HUMAN);
    expect(tierForFlow("createInvite")).toBe(AssuranceTier.UNIQUE_HUMAN);
    expect(tierForFlow("claim")).toBe(AssuranceTier.UNIQUE_HUMAN);
  });

  it("fiat ramp + large send need verified ID (T2)", () => {
    expect(tierForFlow("cashIn")).toBe(AssuranceTier.VERIFIED_ID);
    expect(tierForFlow("cashOut")).toBe(AssuranceTier.VERIFIED_ID);
    expect(tierForFlow("sendLarge")).toBe(AssuranceTier.VERIFIED_ID);
  });
});

describe("tierLabel", () => {
  it("labels every tier", () => {
    expect(tierLabel(AssuranceTier.ANONYMOUS)).toMatch(/anon/i);
    expect(tierLabel(AssuranceTier.UNIQUE_HUMAN)).toMatch(/human/i);
    expect(tierLabel(AssuranceTier.VERIFIED_ID)).toMatch(/id/i);
    expect(tierLabel(AssuranceTier.FULL)).toMatch(/full/i);
  });
});

describe("tierGapMessage", () => {
  it("returns null when the user already meets the bar", () => {
    expect(tierGapMessage(AssuranceTier.VERIFIED_ID, AssuranceTier.UNIQUE_HUMAN)).toBeNull();
    expect(meetsTier(AssuranceTier.VERIFIED_ID, AssuranceTier.UNIQUE_HUMAN)).toBe(true);
  });

  it("returns a user-facing string when a step-up is needed (T1→T2)", () => {
    const msg = tierGapMessage(AssuranceTier.UNIQUE_HUMAN, AssuranceTier.VERIFIED_ID);
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/on-chain/i); // privacy reassurance present
  });

  it("never claims the ID itself goes on-chain", () => {
    for (const need of [AssuranceTier.UNIQUE_HUMAN, AssuranceTier.VERIFIED_ID, AssuranceTier.FULL]) {
      const msg = tierGapMessage(AssuranceTier.ANONYMOUS, need) ?? "";
      expect(msg).not.toMatch(/id goes on-chain/i);
    }
  });
});
