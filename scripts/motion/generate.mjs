#!/usr/bin/env node
/**
 * Generate the Benzo launch film via Motion (motion.so / Mosaic Motion).
 *
 * The API key is read from the environment at runtime (MOTION_KEY) — it is never
 * stored in this file or the repo. Run it yourself so the secret stays with you:
 *
 *   MOTION_KEY=motion_xxx node scripts/motion/generate.mjs
 *
 * Optional env: ASPECT (default 16:9), DURATION (default 30s-1min).
 * Reads the prompt from scripts/motion/prompt.txt and the design system from
 * docs/MOTION-DESIGN.md. Creates the job, then polls until the MP4 is ready and
 * prints the download URL. NOTE: this spends Motion credits.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

// Key comes from your environment, or from a MOTION_KEY=... line in the repo
// .env (gitignored) — never hard-coded here.
function keyFromDotenv() {
  try {
    const env = readFileSync(resolve(repo, ".env"), "utf8");
    return env.match(/^\s*MOTION_KEY\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}
const key = process.env.MOTION_KEY || keyFromDotenv();
if (!key || !key.startsWith("motion_")) {
  console.error("No MOTION_KEY found — add `MOTION_KEY=motion_xxx` to .env, or export it.");
  process.exit(1);
}

const prompt = readFileSync(resolve(here, "prompt.txt"), "utf8").trim();

const body = {
  prompt,
  aspect_ratio: process.env.ASPECT ?? "16:9",
  duration: process.env.DURATION ?? "30s-1min",
};

// design_md is a Pro/Max-tier feature (free tier → "motion_pro_feature_required").
// The brand direction is folded into prompt.txt instead. Set PRO=1 to send it.
if (process.env.PRO === "1") {
  const designMd = readFileSync(resolve(repo, "docs/MOTION-DESIGN.md"), "utf8");
  body.design_md = { filename: "DESIGN.md", content: designMd };
}

const base = "https://api.motion.so/api/motion";
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const create = await fetch(`${base}/sessions`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify(body),
});
if (!create.ok) {
  console.error(`create failed: HTTP ${create.status} — ${await create.text()}`);
  process.exit(1);
}
const { job_id } = await create.json();
console.log(`job: ${job_id} — polling (a designed 60s film takes a few minutes)…`);

for (;;) {
  await sleep(8000);
  const r = await fetch(`${base}/sessions/${job_id}`, { headers: auth });
  if (!r.ok) {
    console.error(`poll failed: HTTP ${r.status}`);
    continue;
  }
  const j = await r.json();
  process.stdout.write(`  status: ${j.status}\r`);
  if (j.status === "completed") {
    console.log(`\n✅ done — download (link expires):\n${j.output?.download_url}`);
    break;
  }
  if (j.status === "failed" || j.error) {
    console.error(`\n✗ failed: ${JSON.stringify(j.error ?? j)}`);
    process.exit(1);
  }
}
