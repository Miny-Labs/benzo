import { describe, it, expect } from "vitest";
import { accountFromSignedMessage, accountFromClaimSecret, NOTE_KEY_MESSAGE } from "../src/account.js";

const sig = new Uint8Array(64).fill(7);
const sig2 = new Uint8Array(64).fill(9);

describe("note keys from one signed message (Railgun pattern)", () => {
  it("is deterministic — the same signature recovers the same account", () => {
    const a = accountFromSignedMessage(sig);
    const b = accountFromSignedMessage(sig);
    expect(a.spendSk).toBe(b.spendSk);
    expect(Buffer.from(a.mvkSecret)).toEqual(Buffer.from(b.mvkSecret));
    expect(Buffer.from(a.viewSecret)).toEqual(Buffer.from(b.viewSecret));
  });
  it("different signatures yield different accounts", () => {
    expect(accountFromSignedMessage(sig).spendSk).not.toBe(accountFromSignedMessage(sig2).spendSk);
  });
  it("is domain-separated from claim-link derivation (same bytes ≠ same keys)", () => {
    expect(accountFromSignedMessage(sig).spendSk).not.toBe(accountFromClaimSecret(sig).spendSk);
  });
  it("exposes the canonical signing message", () => {
    expect(NOTE_KEY_MESSAGE).toBe("BENZO-NOTE-KEY-v1");
  });
});
