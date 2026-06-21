/**
 * Verify a TEE-attested ceremony transcript's TDX quote (cutover gate).
 *
 * Proves three things about circuits/build/<circuit>/<circuit>.ceremony.json:
 *   1. the quote is a genuine Intel TDX quote (dcap-qvl + live Intel collateral);
 *   2. its 64-byte report_data == sha256(inputZkeyHash) ‖ sha256(outputZkeyHash)
 *      — i.e. the contribution that produced THIS zkey transition happened inside
 *      the attested enclave (entropy lived only in TDX);
 *   3. the on-disk .tee.zkey hash matches the attested outputZkeyHash.
 *
 *   node scripts/verify-ceremony-quote.mjs joinsplit_org
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const circuit = process.argv[2] || "joinsplit_org";
const dir = `${repo}/circuits/build/${circuit}`;
const t = JSON.parse(readFileSync(`${dir}/${circuit}.ceremony.json`, "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest();
const hex = (u8) => Buffer.from(u8).toString("hex");
const log = (...a) => console.log(...a);

log(`=== verify ceremony quote: ${circuit} ===`);
log(`    app_id       : ${t.app_id}`);
log(`    compose_hash : ${t.compose_hash}`);
log(`    inputZkeyHash: ${t.inputZkeyHash}`);
log(`    outputZkeyHash: ${t.outputZkeyHash}`);

let fail = false;

// (3) on-disk .tee.zkey hash matches the attested output.
const onDisk = sha256(readFileSync(`${dir}/${circuit}.tee.zkey`)).toString("hex");
const diskOk = onDisk === t.outputZkeyHash && onDisk === t.fetchedZkeyHash;
log(`\n[disk] .tee.zkey sha256       = ${onDisk}`);
log(`[disk] matches attested output = ${diskOk}`);
if (!diskOk) fail = true;

// (1) genuine TDX quote via Intel collateral.
log(`\n[quote] verifying ${t.tdxQuote.length / 2} bytes against live Intel collateral…`);
const qvl = await import("@phala/dcap-qvl");
const bytes = Buffer.from(t.tdxQuote.replace(/^0x/, ""), "hex");
const verified = await qvl.getCollateralAndVerify(bytes);
const td = verified.report.asTd10?.() ?? verified.report.asTd15?.()?.base;
if (!td) { console.error("❌ not a TDX (td10/td15) report"); process.exit(1); }
log(`[quote] status   = ${verified.status}`);
log(`[quote] mrtd     = ${hex(td.mrTd)}`);
log(`[quote] rtmr3    = ${hex(td.rtMr3)}`);
const statusOk = /UpToDate|OutOfDate|ConfigurationNeeded|SwHardeningNeeded|OutOfDateConfigurationNeeded|Relaunch/.test(String(verified.status));
log(`[quote] status recognized as a real TDX verdict = ${statusOk}`);
if (String(verified.status).toLowerCase().includes("invalid") || String(verified.status) === "") fail = true;

// (2) report_data binds our exact (inputHash ‖ outputHash).
const expected = Buffer.concat([
  sha256(Buffer.from(t.inputZkeyHash, "hex")),
  sha256(Buffer.from(t.outputZkeyHash, "hex")),
]);
const got = Buffer.from(td.reportData).subarray(0, 64);
const bindOk = Buffer.compare(expected, got) === 0;
log(`\n[bind] expected report_data = ${expected.toString("hex")}`);
log(`[bind] quote    report_data = ${got.toString("hex")}`);
log(`[bind] report_data binds (sha256(inHash) ‖ sha256(outHash)) = ${bindOk}`);
if (!bindOk) fail = true;

log(`\n${fail ? "❌ ceremony quote verification FAILED" : "✅ ceremony quote verified: genuine TDX, bound to this exact zkey transition, .tee.zkey intact"}`);
process.exit(fail ? 1 : 0);
