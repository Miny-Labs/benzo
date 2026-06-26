import { afterEach, expect, test, vi } from "vitest";

const ENV_KEYS = ["VERCEL", "BENZO_HOSTED_TENANT_TEST", "BENZO_TENANT_STORE_MEMORY", "BENZO_DATA_ENCRYPTION_SECRET"] as const;
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
  process.env.BENZO_HOSTED_TENANT_TEST = "1";
  process.env.BENZO_TENANT_STORE_MEMORY = "1";
  process.env.BENZO_DATA_ENCRYPTION_SECRET = "tenant-store-test-secret";
  const { appendWalletLedger, appendWalletProofReceipt, db, runWithWalletTenant, verifyWalletLedger, walletLedgerBalances } = await import("./store.js");

  await runWithWalletTenant("alice", { name: "Alice" }, { accountFingerprint: "wallet_alice", subjectKey: "alice" }, async () => {
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
    appendWalletProofReceipt({
      action: "wallet.add-money",
      vkId: "SHIELD",
      prover: "tee",
      verified: true,
      txHash: "tx_shield",
      verifier: "verifier_contract",
      publicInputs: { source: "settlement-tx", txHash: "tx_shield" },
    });
    expect(verifyWalletLedger()).toMatchObject({ ok: true, length: 2 });
    expect(walletLedgerBalances()).toMatchObject({ private: "30000000", ramp_reserve: "-30000000" });
  });

  await runWithWalletTenant("bob", { name: "Bob" }, { accountFingerprint: "wallet_bob", subjectKey: "bob" }, async () => {
    expect(db.profile.handle).toBe("@you");
    expect(db.contacts).toEqual([]);
    expect(db.invites).toEqual([]);
    expect(db.ledger).toEqual([]);
    expect(db.proofReceipts).toEqual([]);
    db.profile.handle = "@bob";
  });

  await runWithWalletTenant("alice", null, { accountFingerprint: "wallet_alice", subjectKey: "alice" }, async () => {
    expect(db.profile.handle).toBe("@alice");
    expect(db.contacts).toHaveLength(1);
    expect(db.invites.map((i) => i.localId)).toEqual(["inv_alice"]);
    expect(db.ledger.map((e) => e.sourceType)).toEqual(["onramp", "offramp"]);
    expect(db.proofReceipts.map((r) => [r.action, r.vkId, r.txHash])).toEqual([["wallet.add-money", "SHIELD", "tx_shield"]]);
    expect(verifyWalletLedger()).toMatchObject({ ok: true, length: 2 });
    expect(walletLedgerBalances()).toMatchObject({ private: "30000000", ramp_reserve: "-30000000" });
    db.ledger[0].requestedAmount = "999";
    expect(verifyWalletLedger()).toMatchObject({ ok: false, brokenAt: 0 });
  });
});

test("hosted wallet fails closed when a tenant account binding changes", async () => {
  process.env.BENZO_HOSTED_TENANT_TEST = "1";
  process.env.BENZO_TENANT_STORE_MEMORY = "1";
  process.env.BENZO_DATA_ENCRYPTION_SECRET = "tenant-store-test-secret";
  const { db, RecoveryRequiredError, runWithWalletTenant } = await import("./store.js");

  await runWithWalletTenant("recovery-user", { name: "Recovery" }, { accountFingerprint: "wallet_original", subjectKey: "recovery-user" }, async () => {
    db.profile.handle = "@recovery";
  });

  await expect(
    runWithWalletTenant("recovery-user", null, { accountFingerprint: "wallet_rotated", subjectKey: "recovery-user" }, async () => {
      db.profile.handle = "@wrong";
    }),
  ).rejects.toBeInstanceOf(RecoveryRequiredError);

  await runWithWalletTenant("recovery-user", null, { accountFingerprint: "wallet_original", subjectKey: "recovery-user" }, async () => {
    expect(db.profile.handle).toBe("@recovery");
    expect(db.recovery?.accountFingerprint).toBe("wallet_original");
  });
});

test("hosted wallet refuses the in-memory tenant store on Vercel", async () => {
  process.env.VERCEL = "1";
  process.env.BENZO_TENANT_STORE_MEMORY = "1";
  process.env.BENZO_DATA_ENCRYPTION_SECRET = "tenant-store-test-secret";
  const { loadTenantDocument, tenantStorageMissing } = await import("./tenantData.js");

  expect(tenantStorageMissing()).toContain("BENZO_TENANT_STORE_MEMORY");
  await expect(loadTenantDocument("wallet", "wallet:alice")).rejects.toThrow("BENZO_TENANT_STORE_MEMORY is not allowed");
});
