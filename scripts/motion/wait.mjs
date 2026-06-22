#!/usr/bin/env node
/**
 * Wait for a Motion job's OUTPUT (the MP4) to finish — the top-level session
 * status flips to "completed" while output.status is still "processing", so we
 * poll output.download_url specifically. Key from env or .env.
 *   node scripts/motion/wait.mjs <job_id>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const key =
  process.env.MOTION_KEY ||
  (() => { try { return readFileSync(resolve(repo, ".env"), "utf8").match(/^\s*MOTION_KEY\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, ""); } catch { return undefined; } })();
const jobId = process.argv[2];
if (!key || !jobId) { console.error("usage: node wait.mjs <job_id>"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `https://api.motion.so/api/motion/sessions/${jobId}`;
const auth = { Authorization: `Bearer ${key}` };

for (let i = 0; i < 60; i++) {
  await sleep(10000);
  let j;
  try { j = await (await fetch(url, { headers: auth })).json(); } catch { continue; }
  const out = j.output ?? {};
  console.log(`poll ${i}: output.status=${out.status} dl=${out.download_url ? "READY" : "null"}`);
  if (out.download_url) { console.log(`✅ DOWNLOAD:\n${out.download_url}`); process.exit(0); }
  if (out.status === "failed" || out.error || j.error || j.insufficient_credits) {
    console.log(`✗ ${JSON.stringify(j.error ?? out.error ?? "insufficient_credits")}`); process.exit(1);
  }
}
console.log("gave up after ~10 min — output still not ready");
process.exit(2);
