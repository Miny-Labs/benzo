import { defineConfig, devices } from "@playwright/test";

/**
 * Benzo UI e2e — the deterministic suite. Runs both apps against DEMO-mode BFFs
 * (env creds blanked) so assertions are stable, across a desktop project AND a
 * mobile project (the wallet is mobile-first). Real-testnet proving (local + TEE)
 * lives in playwright.live.config.ts.
 *
 * Servers (Playwright owns their lifecycle):
 *   :8790 console-api (demo)   :8791 wallet-api (demo)
 *   :5174 console (vite dev)   :5175 wallet  (vite dev)
 */
const DEMO_ENV = { SOROBAN_RPC_URL: "", DEPLOYER_SECRET: "" };

export default defineConfig({
  testDir: "./tests/e2e",
  // scope to Playwright specs only — tests/e2e also holds vitest .test.mjs +
  // node .mjs scripts that must NOT be picked up by the Playwright runner.
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "on-first-retry", screenshot: "only-on-failure" },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    // mobile project runs the wallet only (it's the mobile-first product)
    { name: "mobile", use: { ...devices["Pixel 5"] }, testMatch: /wallet\.spec\.ts/ },
  ],

  webServer: [
    {
      command: "node apps/wallet-api/dist/server.js",
      env: { ...DEMO_ENV, WALLET_API_PORT: "8791" },
      url: "http://localhost:8791/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "node apps/console-api/dist/server.js",
      env: { ...DEMO_ENV, CONSOLE_API_PORT: "8790" },
      url: "http://localhost:8790/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @benzo/wallet-app dev",
      url: "http://localhost:5175",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @benzo/console dev",
      url: "http://localhost:5174",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
