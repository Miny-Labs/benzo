#!/usr/bin/env node
/**
 * Guard against a FALSE-GREEN test run. The ZK proving tests self-skip when the
 * (gitignored) zkey/wasm artifacts are absent — so `pnpm test` can pass without
 * ever exercising a proof. This script asserts the load-bearing artifacts exist
 * and exits non-zero (with a clear fix) if they don't, so `pnpm test:zk` can
 * GUARANTEE the ZK actually ran.
 *
 *   node scripts/check-artifacts.mjs          # exit 1 if any required artifact is missing
 *   node scripts/check-artifacts.mjs --warn    # print status, never fail (informational)
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const warnOnly = process.argv.includes("--warn");

// The artifacts that gate the on-chain ZK money path + the browser proving demo.
const REQUIRED = [
  // settle-gate circuits (verified inside the pool / asp_membership on-chain)
  ["circuits/build/shield/shield.zkey", "SHIELD proving key"],
  ["circuits/build/joinsplit/joinsplit.zkey", "TRANSFER (joinsplit) proving key"],
  ["circuits/build/unshield/unshield.zkey", "UNSHIELD proving key"],
  ["circuits/build/kyc_credential/kyc_credential.zkey", "ZK-KYC credential proving key"],
  // browser proving (client-side, secrets never leave the device)
  ["apps/wallet/public/circuits/joinsplit.zkey", "browser TRANSFER zkey"],
  ["apps/wallet/public/circuits/joinsplit.wasm", "browser TRANSFER wasm"],
];

const missing = [];
for (const [rel, label] of REQUIRED) {
  const p = join(ROOT, rel);
  const ok = existsSync(p) && statSync(p).size > 0;
  console.log(`${ok ? "ok " : "MISSING"}  ${rel}  (${label})`);
  if (!ok) missing.push(rel);
}

if (missing.length === 0) {
  console.log("\nAll load-bearing ZK artifacts present — proofs will actually run.");
  process.exit(0);
}

console.error(
  `\n${missing.length} required ZK artifact(s) missing. The proving tests would SILENTLY SKIP — a green run would NOT mean the ZK works.\n` +
    `\nFix one of:\n` +
    `  • Build from source (deploy your own contracts):   bash scripts/build-artifacts.sh\n` +
    `  • Fetch the exact published artifacts (use the deployed Benzo testnet):  bash scripts/fetch-artifacts.sh\n`,
);
process.exit(warnOnly ? 0 : 1);
