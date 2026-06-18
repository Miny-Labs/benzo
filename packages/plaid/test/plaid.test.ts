/**
 * PlaidClient — faked-fetch unit tests (deterministic, no network) plus a LIVE
 * sandbox integration test that self-skips without PLAID creds (mirrors the e2e
 * convention). The live test confirms the sandbox keys actually fetch a balance.
 */
import { describe, it, expect } from "vitest";
import { PlaidClient } from "../src/index.js";

/** Route a fake response by request path. */
function fakeFetch(routes: Record<string, unknown>, errorFor?: string): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (errorFor && path === errorFor) {
      return { ok: false, json: async () => ({ error_code: "INVALID_API_KEYS", error_message: "bad keys" }) };
    }
    const body = routes[path];
    if (body === undefined) throw new Error(`unexpected path ${path}`);
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
}

const ROUTES = {
  "/sandbox/public_token/create": { public_token: "public-sandbox-abc" },
  "/item/public_token/exchange": { access_token: "access-sandbox-xyz" },
  "/accounts/balance/get": {
    accounts: [
      { account_id: "acc_1", name: "Plaid Checking", balances: { available: 1500.5, current: 1600, iso_currency_code: "USD" } },
    ],
  },
};

describe("PlaidClient (unit)", () => {
  it("creates a sandbox public token, exchanges it, and reads balances", async () => {
    const c = new PlaidClient({ clientId: "id", secret: "sk", fetchImpl: fakeFetch(ROUTES) });
    expect(await c.sandboxCreatePublicToken()).toBe("public-sandbox-abc");
    expect(await c.exchangePublicToken("public-sandbox-abc")).toBe("access-sandbox-xyz");
    const accts = await c.getBalances("access-sandbox-xyz");
    expect(accts[0].balances.available).toBe(1500.5);
  });

  it("sandboxBalance runs the full flow and returns the first account's balance", async () => {
    const c = new PlaidClient({ clientId: "id", secret: "sk", fetchImpl: fakeFetch(ROUTES) });
    const bal = await c.sandboxBalance();
    expect(bal).toEqual({ accountId: "acc_1", available: 1500.5, current: 1600, currency: "USD" });
  });

  it("surfaces Plaid error_code as a thrown error", async () => {
    const c = new PlaidClient({ clientId: "bad", secret: "bad", fetchImpl: fakeFetch(ROUTES, "/sandbox/public_token/create") });
    await expect(c.sandboxCreatePublicToken()).rejects.toThrow(/INVALID_API_KEYS/);
  });
});

const HAVE_LIVE = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

describe.skipIf(!HAVE_LIVE)("PlaidClient (live sandbox)", () => {
  it("fetches a real sandbox balance with the configured keys", async () => {
    const c = new PlaidClient({
      clientId: process.env.PLAID_CLIENT_ID!,
      secret: process.env.PLAID_SECRET!,
      env: "sandbox",
    });
    const bal = await c.sandboxBalance();
    expect(bal.accountId).toBeTruthy();
    // sandbox returns a numeric available or current balance
    expect(typeof (bal.available ?? bal.current)).toBe("number");
  }, 60_000);
});
