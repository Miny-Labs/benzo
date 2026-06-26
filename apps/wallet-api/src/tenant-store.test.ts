import { afterEach, expect, test, vi } from "vitest";

const ENV_KEYS = ["VERCEL", "BENZO_TENANT_STORE_MEMORY", "BENZO_DATA_ENCRYPTION_SECRET"] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = originalEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

test("hosted wallet UX, invites, and accounting state are encrypted and partitioned by auth key", async () => {
  process.env.VERCEL = "1";
  process.env.BENZO_TENANT_STORE_MEMORY = "1";
  process.env.BENZO_DATA_ENCRYPTION_SECRET = "tenant-store-test-secret";
  const { appendWalletLedger, db, runWithWalletTenant, verifyWalletLedger, walletLedgerBalances } = await import("./store.js");

  await runWithWalletTenant("alice", { name: "Alice" }, async () => {
    db.profile.handle = "@alice";
    db.contacts.push({ handle: "@bob", name: "Bob" });
    db.invites.push({
      localId: "inv_alice",
      amount: "30000000",
      note: "private invite",
      link: "https://wallet.benzo.space/claim#alice",
      secret: "encrypted-in-tenant-doc",
      createdAt: 1,
      expiresAt: 2,
      status: "pending",
    });
    appendWalletLedger({
      sourceType: "onramp",
      status: "settled",
      txId: "tx_onramp",
      requestedAmount: "3",
      lines: [
        { accountId: "ramp_reserve", direction: "debit", amount: "30000000", assetCode: "USDC" },
        { accountId: "private", direction: "credit", amount: "30000000", assetCode: "USDC" },
      ],
    });
    appendWalletLedger({
      sourceType: "offramp",
      status: "failed",
      requestedAmount: "100",
      lines: [],
      errorCode: "reserve",
      error: "The cash reserve is topping up. Try again in a moment, or a smaller amount.",
    });
    expect(verifyWalletLedger()).toMatchObject({ ok: true, length: 2 });
    expect(walletLedgerBalances()).toMatchObject({ private: "30000000", ramp_reserve: "-30000000" });
  });

  await runWithWalletTenant("bob", { name: "Bob" }, async () => {
    expect(db.profile.handle).toBe("@you");
    expect(db.contacts).toEqual([]);
    expect(db.invites).toEqual([]);
    expect(db.ledger).toEqual([]);
    db.profile.handle = "@bob";
  });

  await runWithWalletTenant("alice", null, async () => {
    expect(db.profile.handle).toBe("@alice");
    expect(db.contacts).toHaveLength(1);
    expect(db.invites.map((i) => i.localId)).toEqual(["inv_alice"]);
    expect(db.ledger.map((e) => e.sourceType)).toEqual(["onramp", "offramp"]);
    expect(verifyWalletLedger()).toMatchObject({ ok: true, length: 2 });
    expect(walletLedgerBalances()).toMatchObject({ private: "30000000", ramp_reserve: "-30000000" });
    db.ledger[0].requestedAmount = "999";
    expect(verifyWalletLedger()).toMatchObject({ ok: false, brokenAt: 0 });
  });
});
