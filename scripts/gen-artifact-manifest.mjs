#!/usr/bin/env node
/**
 * Generate artifacts-manifest.json from circuits/build — the index the client
 * uses to discover + integrity-check proving artifacts. For each circuit with a
 * built zkey + wasm + vk, emit {vkHash, zkeyUrl, wasmUrl, zkeyHash, wasmHash,
 * sizeBytes}. vkHash = sha256 of the VK JSON (cache key + auto-invalidation);
 * zkeyHash/wasmHash = sha256 content digests (download integrity).
 *
 * Usage: node scripts/gen-artifact-manifest.mjs [baseUrl]
 *   baseUrl default: https://artifacts.benzo.local  (placeholder CDN origin)
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // handles spaces in path
const BUILD = `${ROOT}circuits/build`;
const BASE_URL = process.argv[2] ?? "https://artifacts.benzo.local";

const CIRCUITS = [
  "shield", "joinsplit", "unshield",
  "proof_of_balance", "proof_of_sum", "kyc_credential", "funds_attestation",
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const circuits = {};
for (const c of CIRCUITS) {
  const zkey = `${BUILD}/${c}/${c}.zkey`;
  const wasm = `${BUILD}/${c}/${c}_js/${c}.wasm`;
  const vk = `${BUILD}/${c}/${c}_vk.json`;
  if (!existsSync(zkey) || !existsSync(wasm) || !existsSync(vk)) {
    console.warn(`skip ${c}: missing artifact(s)`);
    continue;
  }
  const zkeyBuf = readFileSync(zkey);
  const wasmBuf = readFileSync(wasm);
  const vkBuf = readFileSync(vk);
  circuits[c] = {
    circuit: c,
    vkHash: sha(vkBuf),
    zkeyUrl: `${BASE_URL}/${c}/${c}.zkey`,
    wasmUrl: `${BASE_URL}/${c}/${c}.wasm`,
    zkeyHash: sha(zkeyBuf),
    wasmHash: sha(wasmBuf),
    sizeBytes: statSync(zkey).size,
  };
  console.log(`+ ${c}: zkey ${(statSync(zkey).size / 1e6).toFixed(1)}MB  vk ${circuits[c].vkHash.slice(0, 12)}…`);
}

const manifest = { generatedAt: new Date().toISOString(), circuits };
const out = `${ROOT}circuits/build/artifacts-manifest.json`;
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`wrote ${out} (${Object.keys(circuits).length} circuits)`);
