import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, expect, test, vi } from "vitest";

const ENV_KEYS = [
  "VERCEL",
  "DEPLOYER_SECRET",
  "BENZO_OPERATOR_ADMIN_SECRET",
  "BENZO_RAMP_ADMIN_SECRET",
  "RAMP_ADMIN_SECRET",
  "SOROBAN_RPC_URL",
  "GOOGLE_CLIENT_ID",
  "BENZO_ACCOUNT_SALT",
  "RELAYER_SECRET",
  "BENZO_PROVER_ENDPOINT",
  "BENZO_PROVER_MEASUREMENT",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = originalEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

test("hosted wallet derives stable unique accounts per auth subject", async () => {
  vi.resetModules();
  process.env.VERCEL = "1";
  process.env.BENZO_ACCOUNT_SALT = "stable-account-salt";
  process.env.BENZO_TEST_AUTH_SECRET = "wallet-hosted-auth-secret";
  vi.doMock("./tenantData.js", () => ({
    loadTenantDocument: vi.fn(async () => null),
    tenantStorageMissing: vi.fn(() => []),
  }));
  const { accountFingerprint, authFromRequest, createTestAuthToken } = await import("./auth.js");

  const alice = createTestAuthToken({ subject: "alice", email: "alice@example.test" });
  const aliceAgain = createTestAuthToken({ subject: "alice", email: "alice@example.test" });
  const bob = createTestAuthToken({ subject: "bob", email: "bob@example.test" });
  const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  const aliceAuth = await authFromRequest(req(alice) as never);
  const aliceAgainAuth = await authFromRequest(req(aliceAgain) as never);
  const bobAuth = await authFromRequest(req(bob) as never);

  expect(aliceAuth?.key).toBe(aliceAgainAuth?.key);
  expect(accountFingerprint(aliceAuth!.account)).toBe(accountFingerprint(aliceAgainAuth!.account));
  expect(aliceAuth?.key).not.toBe(bobAuth?.key);
  expect(accountFingerprint(aliceAuth!.account)).not.toBe(accountFingerprint(bobAuth!.account));
  expect(aliceAuth!.account.stellarAddress).not.toBe(bobAuth!.account.stellarAddress);
});

test("hosted wallet never derives a public user account from DEPLOYER_SECRET without auth", async () => {
  vi.resetModules();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.VERCEL = "1";
  process.env.DEPLOYER_SECRET = Keypair.random().secret();
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

  const { getClient } = await import("./chain.js");

  expect(getClient("tee")).toBeNull();
  expect(err).toHaveBeenCalledWith("[wallet-api] live client unavailable; refusing app data");
});

test("hosted wallet live status does not depend on DEPLOYER_SECRET", async () => {
  vi.resetModules();
  delete process.env.DEPLOYER_SECRET;
  process.env.BENZO_OPERATOR_ADMIN_SECRET = Keypair.random().secret();
  process.env.VERCEL = "1";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.BENZO_ACCOUNT_SALT = "stable-account-salt";
  process.env.RELAYER_SECRET = Keypair.random().secret();

  const { liveStatus } = await import("./chain.js");

  expect(liveStatus()).toMatchObject({ live: true, mode: "live", missing: [] });
});

test("hosted wallet reports missing operator admin signer separately from user auth", async () => {
  vi.resetModules();
  process.env.DEPLOYER_SECRET = Keypair.random().secret();
  delete process.env.BENZO_OPERATOR_ADMIN_SECRET;
  delete process.env.BENZO_RAMP_ADMIN_SECRET;
  delete process.env.RAMP_ADMIN_SECRET;
  process.env.VERCEL = "1";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.BENZO_ACCOUNT_SALT = "stable-account-salt";
  process.env.RELAYER_SECRET = Keypair.random().secret();

  const { liveStatus } = await import("./chain.js");

  expect(liveStatus()).toMatchObject({
    live: false,
    mode: "unavailable",
    missing: ["BENZO_OPERATOR_ADMIN_SECRET"],
  });
});
