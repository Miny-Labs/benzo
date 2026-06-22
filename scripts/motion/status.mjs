#!/usr/bin/env node
/**
 * Inspect a Motion job. Key read from env or .env (never hard-coded).
 *   node scripts/motion/status.mjs <job_id>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
function keyFromDotenv() {
  try {
    return readFileSync(resolve(repo, ".env"), "utf8")
      .match(/^\s*MOTION_KEY\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "");
  } catch { return undefined; }
}
const key = process.env.MOTION_KEY || keyFromDotenv();
const jobId = process.argv[2];
if (!key || !jobId) { console.error("usage: node status.mjs <job_id> (MOTION_KEY in env/.env)"); process.exit(1); }

const r = await fetch(`https://api.motion.so/api/motion/sessions/${jobId}`, {
  headers: { Authorization: `Bearer ${key}` },
});
const j = await r.json();
// Print everything EXCEPT nothing sensitive (no key is echoed); download_url is a signed asset URL.
console.log(JSON.stringify(j, null, 2));
