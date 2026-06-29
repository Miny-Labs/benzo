import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, expect, test, vi } from "vitest";

const ENV_KEYS = ["VERCEL", "DEPLOYER_SECRET", "BENZO_OPERATOR_ADMIN_SECRET", "BENZO_CONSOLE_ADMIN_SECRET", "SOROBAN_RPC_URL", "GOOGLE_CLIENT_ID", "BENZO_ACCOUNT_SALT", "RELAYER_SECRET", "BENZO_PRIVATE_EVENT_SECRET", "BENZO_PROVER_ENDPOINT", "BENZO_PROVER_MEASUREMENT"] as const;
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

test("hosted console never derives a public org treasury from DEPLOYER_SECRET without auth", async () => {
  vi.resetModules();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.VERCEL = "1";
  process.env.DEPLOYER_SECRET = Keypair.random().secret();
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

  const { getClient } = await import("./chain.js");

  expect(getClient()).toBeNull();
  expect(err).toHaveBeenCalledWith("[console-api] live client unavailable; refusing app data");
});

test("hosted console live status does not depend on DEPLOYER_SECRET", async () => {
  vi.resetModules();
  delete process.env.DEPLOYER_SECRET;
  process.env.VERCEL = "1";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.BENZO_ACCOUNT_SALT = "stable-account-salt";
  process.env.RELAYER_SECRET = Keypair.random().secret();
  process.env.BENZO_OPERATOR_ADMIN_SECRET = Keypair.random().secret();
  process.env.BENZO_PRIVATE_EVENT_SECRET = "private-event-secret";

  const { liveStatus } = await import("./chain.js");

  expect(liveStatus()).toMatchObject({ live: true, mode: "live", missing: [] });
});

test("hosted console reports missing operator admin signer separately from user auth", async () => {
  vi.resetModules();
  delete process.env.DEPLOYER_SECRET;
  delete process.env.BENZO_OPERATOR_ADMIN_SECRET;
  delete process.env.BENZO_CONSOLE_ADMIN_SECRET;
  process.env.VERCEL = "1";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.BENZO_ACCOUNT_SALT = "stable-account-salt";
  process.env.RELAYER_SECRET = Keypair.random().secret();
  process.env.BENZO_PRIVATE_EVENT_SECRET = "private-event-secret";

  const { liveStatus } = await import("./chain.js");

  expect(liveStatus()).toMatchObject({
    live: false,
    mode: "unavailable",
    missing: ["BENZO_OPERATOR_ADMIN_SECRET"],
  });
});
