/**
 * Validate the prover-enclave CONTAINER (run locally, before deploying to the
 * live CVM): build a real funds_attestation witness, POST it to the container's
 * /prove, and verify the returned proof ON-CHAIN against the deployed FUNDS VK.
 * This proves the in-container snarkjs path produces on-chain-valid proofs.
 *
 * Usage: BENZO_PROVER_LOCAL=http://localhost:8080 node scripts/tee-validate-local.mjs
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { StellarCli, configFromEnv, proofToSoroban, publicsToSoroban } from "../dist/index.js";

const ENDPOINT = process.env.BENZO_PROVER_LOCAL || "http://localhost:8080";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${repo}/deployments/testnet.json`, "utf8"));

const eddsa = await buildEddsa();
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (xs) => F.toObject(poseidon(xs));

// Same witness as the funds_attestation on-chain check.
const THRESHOLD = 500_000n, ASSET_ID = 7n, TIMESTAMP = 1_700_000_000n;
const CURRENT_TIME = 1_700_000_500n, MAX_AGE = 3_600n, BALANCE = 1_000_000n, HOLDER_SK = 12345n;
const oraclePrv = Buffer.alloc(32, 5);
const oraclePub = eddsa.prv2pub(oraclePrv);
const oracleAx = F.toObject(oraclePub[0]), oracleAy = F.toObject(oraclePub[1]);
const oracleKeyId = H([oracleAx, oracleAy]);
const hp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, HOLDER_SK);
const holderBinding = H([F.toObject(hp[0]), F.toObject(hp[1])]);
const sig = eddsa.signPoseidon(oraclePrv, poseidon([holderBinding, BALANCE, ASSET_ID, TIMESTAMP]));

// snarkjs input must be strings.
const input = Object.fromEntries(
  Object.entries({
    oracleKeyId, threshold: THRESHOLD, assetId: ASSET_ID, currentTime: CURRENT_TIME,
    maxAgeSeconds: MAX_AGE, holderBinding, oracleAx, oracleAy,
    sigS: sig.S, sigR8x: F.toObject(sig.R8[0]), sigR8y: F.toObject(sig.R8[1]),
    balance: BALANCE, timestamp: TIMESTAMP, holderSk: HOLDER_SK,
  }).map(([k, v]) => [k, v.toString()]),
);

console.log(`[1] POST ${ENDPOINT}/prove (circuit=funds_attestation) — proving IN the container`);
const res = await fetch(`${ENDPOINT}/prove`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ circuit: "funds_attestation", input }),
});
if (!res.ok) throw new Error(`/prove HTTP ${res.status}: ${await res.text()}`);
const { proof, publicSignals } = await res.json();
console.log(`    got proof (${publicSignals.length} public signals)`);

const sorobanProof = proofToSoroban(proof);
const sorobanPublics = publicsToSoroban(publicSignals);

console.log(`[2] verify_proof --vk_id FUNDS on-chain (verifier ${dep.verifier})`);
const cli = new StellarCli(configFromEnv());
const ok = await cli.view(dep.verifier, "benzo-deployer", [
  "verify_proof", "--vk_id", "FUNDS",
  "--proof", JSON.stringify(sorobanProof),
  "--public_inputs", JSON.stringify(sorobanPublics),
]);
console.log(`    on-chain verify => ${ok}`);
if (ok !== true) { console.error("❌ container proof did NOT verify on-chain"); process.exit(1); }
console.log("\n✅ CONTAINER proof verifies ON-CHAIN — in-enclave snarkjs path is correct");
