/**
 * TEE-attested phase-2 ceremony — host orchestrator.
 *
 * Drives the in-enclave `/contribute` (services/prover-enclave) on a live Phala
 * TDX CVM: the enclave contributes to `<circuit>.zkey` with entropy generated and
 * destroyed INSIDE the sealed enclave, and returns a TDX quote binding
 * (inputZkeyHash ‖ outputZkeyHash). We fetch the new (PUBLIC) zkey, export its VK,
 * and write a ceremony transcript. A solo operator gets a credibly "1-of-N honest"
 * setup: the attested enclave is the independent party.
 *
 *   BENZO_ENCLAVE_URL=https://<app-id>-8080.<node>.phala.network \
 *   node scripts/tee-ceremony.mjs joinsplit_org
 */
import { writeFileSync, createWriteStream, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const repo = fileURLToPath(new URL("..", import.meta.url));
const circuit = process.argv[2] || "joinsplit_org";
const BASE = process.env.BENZO_ENCLAVE_URL;
if (!BASE) { console.error("set BENZO_ENCLAVE_URL to the CVM origin"); process.exit(1); }
const outDir = `${repo}/circuits/build/${circuit}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.log(...a);

log(`=== TEE-attested ceremony for ${circuit} @ ${BASE} ===`);

log("[1] enclave /info (app_id, compose_hash)…");
const info = await (await fetch(`${BASE}/info`)).json().catch(() => ({}));
log(`    app_id=${info.app_id ?? "?"} compose_hash=${info.compose_hash ?? "?"} instance=${info.instance_id ?? "?"}`);

log(`[2] POST /contribute { circuit: ${circuit} } — in-enclave entropy, ~minutes…`);
const cRes = await fetch(`${BASE}/contribute`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ circuit, name: "benzo-tee-ceremony" }),
});
if (!cRes.ok) { console.error("contribute failed:", cRes.status, await cRes.text()); process.exit(1); }
const c = await cRes.json();
log(`    inputZkeyHash : ${c.inputZkeyHash}`);
log(`    outputZkeyHash: ${c.outputZkeyHash}`);
log(`    TDX quote     : ${c.quote ? c.quote.slice(0, 48) + "… (" + c.quote.length + " hex)" : "MISSING (not in a CVM?)"}`);

log(`[3] GET /artifact?name=${circuit}.contrib.zkey — fetching the contributed (public) zkey…`);
const aRes = await fetch(`${BASE}/artifact?name=${circuit}.contrib.zkey`);
if (!aRes.ok) { console.error("artifact fetch failed:", aRes.status); process.exit(1); }
const dest = `${outDir}/${circuit}.tee.zkey`;
await new Promise((resolve, reject) => {
  const ws = createWriteStream(dest);
  Readable.fromWeb(aRes.body).pipe(ws).on("finish", resolve).on("error", reject);
});
const fetchedHash = sha(readFileSync(dest));
log(`    saved ${dest}`);
log(`    fetched hash  : ${fetchedHash}`);
log(`    matches enclave outputHash: ${fetchedHash === c.outputZkeyHash}`);
if (fetchedHash !== c.outputZkeyHash) { console.error("❌ fetched zkey hash != enclave-attested output hash"); process.exit(1); }

// Persist the transcript (with the TDX quote) NOW — before the VK export — so a
// late failure can never lose the one-time attestation from the /contribute call.
const transcriptPath = `${repo}/circuits/build/${circuit}/${circuit}.ceremony.json`;
const transcript = {
  circuit, enclave: BASE, app_id: info.app_id, compose_hash: info.compose_hash, instance_id: info.instance_id,
  inputZkeyHash: c.inputZkeyHash, outputZkeyHash: c.outputZkeyHash, fetchedZkeyHash: fetchedHash,
  tdxQuote: c.quote, eventLog: c.event_log, vkNPublic: null,
};
writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
log(`    transcript (quote persisted) → ${transcriptPath}`);

log("[4] export VK from the TEE-contributed zkey…");
const snarkjs = await import("snarkjs");
const vk = await snarkjs.zKey.exportVerificationKey(dest);
writeFileSync(`${outDir}/${circuit}_tee_vk.json`, JSON.stringify(vk));
log(`    VK nPublic=${vk.nPublic} → ${outDir}/${circuit}_tee_vk.json`);

transcript.vkNPublic = vk.nPublic; // backfill now that the export succeeded
writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
log(`\n✅ TEE contribution complete. Transcript: circuits/build/${circuit}/${circuit}.ceremony.json`);
log("   Next (cutover): verify the TDX quote (dcap-qvl), then set_vk JSPLITORG with the TEE VK + re-run the e2e against the .tee.zkey.");
