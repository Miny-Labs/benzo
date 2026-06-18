/**
 * Browser TEE proving path — exercises the EXACT code a mobile/extension UI runs:
 * client-side WASM attestation (@phala/dcap-qvl-web) → seal witness to the
 * attested key → prove funds_attestation INSIDE the live enclave → verify the
 * enclave-produced proof ON-CHAIN. Run in Node (same WASM + same TS as browser).
 *
 *   BENZO_PROVER_ENDPOINT=https://<app-id>-8080.<node>.phala.network \
 *   node tests/e2e/tee-browser-path.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import {
  StellarCli, configFromEnv, PhalaProver,
  makeWebAttestationVerifier, pickBrowserProver, initWebAttestation,
} from "@benzo/core";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const dep = JSON.parse(readFileSync(`${repo}/deployments/testnet.json`, "utf8"));
const ENDPOINT = process.env.BENZO_PROVER_ENDPOINT || dep.tee?.endpoint;
const MEASUREMENT = dep.tee?.composeHash;
if (!ENDPOINT || !MEASUREMENT) throw new Error("need deployments/testnet.json tee.endpoint + tee.composeHash");
const cli = new StellarCli(configFromEnv());
const log = (...a) => console.log(...a);

// In a browser the bundler loads the wasm automatically; in Node we feed the bytes.
let wasmPath;
try { wasmPath = require.resolve("@phala/dcap-qvl-web/dcap-qvl-web_bg.wasm"); }
catch { wasmPath = process.env.BENZO_QVL_WASM; }
await initWebAttestation(readFileSync(wasmPath));

log("=== Browser TEE proving path (WASM attestation, mobile/extension) ===");
log(`endpoint: ${ENDPOINT}`);
log(`pinned measurement (compose-hash): ${MEASUREMENT.slice(0, 16)}…`);

// Build a real funds_attestation witness (the tiny secret that gets sealed).
const eddsa = await buildEddsa();
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (xs) => F.toObject(poseidon(xs));
const THRESHOLD = 500_000n, ASSET_ID = 7n, TIMESTAMP = 1_700_000_000n;
const CURRENT_TIME = 1_700_000_500n, MAX_AGE = 3_600n, BALANCE = 1_000_000n, HOLDER_SK = 12345n;
const oraclePrv = Buffer.alloc(32, 5);
const oraclePub = eddsa.prv2pub(oraclePrv);
const oracleAx = F.toObject(oraclePub[0]), oracleAy = F.toObject(oraclePub[1]);
const oracleKeyId = H([oracleAx, oracleAy]);
const hp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, HOLDER_SK);
const holderBinding = H([F.toObject(hp[0]), F.toObject(hp[1])]);
const sig = eddsa.signPoseidon(oraclePrv, poseidon([holderBinding, BALANCE, ASSET_ID, TIMESTAMP]));
const input = Object.fromEntries(Object.entries({
  oracleKeyId, threshold: THRESHOLD, assetId: ASSET_ID, currentTime: CURRENT_TIME,
  maxAgeSeconds: MAX_AGE, holderBinding, oracleAx, oracleAy,
  sigS: sig.S, sigR8x: F.toObject(sig.R8[0]), sigR8y: F.toObject(sig.R8[1]),
  balance: BALANCE, timestamp: TIMESTAMP, holderSk: HOLDER_SK,
}).map(([k, v]) => [k, v.toString()]));

// [1] client-side WASM attestation of the live enclave
log("\n[1] WASM-verifying the live TDX quote (dcap-qvl-web, browser path) …");
const verifier = makeWebAttestationVerifier();
const att = await verifier.verify(ENDPOINT);
log(`    TCB ${att.status} · compose-hash ${att.composeHash?.slice(0, 16)}… · attested encPub ${att.enclavePublicKey?.slice(0, 16)}…`);
if (!att.ok) { console.error("❌ WASM attestation failed"); process.exit(1); }

// [2] prove inside the enclave via PhalaProver (witness sealed to the attested key)
log("\n[2] sealing witness + proving funds_attestation INSIDE the enclave …");
const prover = new PhalaProver(ENDPOINT, verifier, MEASUREMENT);
const proof = await prover.prove({ wasmPath: "", zkeyPath: "", circuit: "funds_attestation" }, input);
log(`    enclave returned proof (${proof.publicSignals.length} public signals)`);

// [3] verify the enclave-produced proof on-chain
const ok = await cli.view(dep.verifier, "benzo-deployer", [
  "verify_proof", "--vk_id", "FUNDS",
  "--proof", JSON.stringify(proof.sorobanProof),
  "--public_inputs", JSON.stringify(proof.sorobanPublics),
]);
log(`\n[3] on-chain verify_proof FUNDS => ${ok}`);
if (ok !== true) { console.error("❌ enclave proof did NOT verify on-chain"); process.exit(1); }

// [4] the device auto-router: a "mobile" device must select the TEE prover
const routed = pickBrowserProver({ mode: "auto", device: { isMobile: true }, tee: { endpoint: ENDPOINT, measurement: MEASUREMENT } });
log(`\n[4] pickBrowserProver(mobile) -> "${routed.name}" prover ${routed.name === "phala" ? "✅ (routes to TEE)" : "❌"}`);
if (routed.name !== "phala") process.exit(1);

log("\n=== BROWSER TEE PATH PASSED — phone/extension attests (WASM) + proves in the enclave + verifies on-chain ===");
