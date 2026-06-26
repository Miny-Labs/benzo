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

test("hosted console starts empty and partitions org documents by auth key", async () => {
  process.env.VERCEL = "1";
  process.env.BENZO_TENANT_STORE_MEMORY = "1";
  process.env.BENZO_DATA_ENCRYPTION_SECRET = "tenant-store-test-secret";
  const { db, runWithConsoleTenant } = await import("./store.js");

  await runWithConsoleTenant("alice", { email: "alice@example.com", name: "Alice" }, async () => {
    expect(db.counterparties).toEqual([]);
    expect(db.invoices).toEqual([]);
    db.org.name = "Alice LLC";
    db.counterparties.push({
      id: "cp_alice",
      orgId: db.org.id,
      name: "Alice Contractor",
      type: "contractor",
      status: "pending_screening",
      externalAccounts: [],
      createdAt: new Date().toISOString(),
    });
  });

  await runWithConsoleTenant("bob", { email: "bob@example.com", name: "Bob" }, async () => {
    expect(db.org.name).toBe("New workspace");
    expect(db.counterparties).toEqual([]);
    expect(db.payments).toEqual([]);
  });

  await runWithConsoleTenant("alice", null, async () => {
    expect(db.org.name).toBe("Alice LLC");
    expect(db.counterparties.map((c) => c.id)).toEqual(["cp_alice"]);
  });
});

test("hosted console persists operational state in the encrypted tenant document", async () => {
  process.env.VERCEL = "1";
  process.env.BENZO_TENANT_STORE_MEMORY = "1";
  process.env.BENZO_DATA_ENCRYPTION_SECRET = "tenant-store-test-secret";
  const { db, runWithConsoleTenant } = await import("./store.js");

  await runWithConsoleTenant("ops", { email: "ops@example.com", name: "Ops" }, async () => {
    db.onboarding = { name: "Ops Treasury", country: "US" };
    db.invites.push({
      id: "invite_ops",
      kind: "contractor",
      name: "Private Contractor",
      counterpartyId: "cp_ops",
      link: "https://wallet.benzo.space/claim#secret",
      token: "tok_ops",
      status: "sent",
      createdAt: new Date().toISOString(),
    });
    db.payrolls.push({
      id: "pr_ops",
      orgId: db.org.id,
      period: "2026-06",
      source: "manual",
      status: "needs_approval",
      lines: [{ counterpartyId: "cp_ops", amount: "10000000", settlementHandle: "@ops", status: "pending" }],
      total: { amount: "10000000", assetCode: "USDC" },
      createdAt: new Date().toISOString(),
    });
    db.privateEvents.push({
      id: "pe_ops",
      orgId: `org-ops`,
      type: "payment.submitted",
      subjectId: "po_ops",
      schema: "payment.order.v1",
      occurredAt: new Date().toISOString(),
      publicMeta: { status: "needs_approval" },
      ciphertext: "cipher",
      iv: "iv",
      tag: "tag",
      aadHash: "aad",
      payloadHash: "payload",
      prevHash: "GENESIS",
      hash: "hash",
    });
    db.rateLimits.write = { windowStart: Date.now(), count: 7 };
    db.proofReceipts.push({
      id: "prf_ops",
      action: "treasury.prove-total",
      vkId: "ORGSUM",
      verified: true,
      verifier: "verifier_contract",
      network: "testnet",
      publicInputs: [{ k: "Total", v: "hidden" }],
      createdAt: new Date().toISOString(),
    });
    db.idempotency["POST:/api/payments:key_ops"] = {
      bodyHash: "hash_ops",
      status: 201,
      body: { id: "po_ops" },
      createdAt: new Date().toISOString(),
    };
  });

  await runWithConsoleTenant("ops", null, async () => {
    expect(db.onboarding).toMatchObject({ name: "Ops Treasury", country: "US" });
    expect(db.invites.map((i) => i.id)).toEqual(["invite_ops"]);
    expect(db.payrolls[0].lines[0].settlementHandle).toBe("@ops");
    expect(db.privateEvents.map((e) => e.id)).toEqual(["pe_ops"]);
    expect(db.rateLimits.write.count).toBe(7);
    expect(db.proofReceipts.map((r) => r.vkId)).toEqual(["ORGSUM"]);
    expect(db.idempotency["POST:/api/payments:key_ops"]).toMatchObject({ bodyHash: "hash_ops", status: 201 });
  });
});
