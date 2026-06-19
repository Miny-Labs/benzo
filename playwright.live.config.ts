import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE proving suite — drives the wallet UI against a LIVE wallet-api that settles
 * REAL testnet USDC, exercising BOTH proving paths (on-device/local + attested
 * TEE). Slow by nature (real Groth16 + Soroban + the enclave round-trip), so it's
 * a separate config from the deterministic UI suite. Requires: .env loaded (the
 * BFF auto-loads it), a funded ~/.benzo wallet with shielded notes, and the live
 * Phala enclave reachable for the TEE leg.
 *
 *   pnpm exec playwright test -c playwright.live.config.ts
 */
export default defineConfig({
  testDir: "./tests/live",
  testMatch: "**/*.spec.ts",
  timeout: 240_000, // a real prove+submit (esp. via the TEE) can take minutes
  expect: { timeout: 200_000 },
  fullyParallel: false,
  workers: 1, // NEVER run live legs concurrently — they share one wallet + tx source
  retries: 0,
  reporter: [["list"]],
  use: { trace: "on", screenshot: "only-on-failure" },

  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } }],

  webServer: [
    {
      // LIVE: no env override → the BFF auto-loads .env and settles on testnet.
      command: "node apps/wallet-api/dist/server.js",
      env: { WALLET_API_PORT: "8791" },
      url: "http://localhost:8791/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @benzo/wallet-app dev",
      url: "http://localhost:5175",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
