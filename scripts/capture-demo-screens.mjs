/**
 * Capture the consumer-app demo screens to docs/demo-flow/screens/*.png via
 * Playwright (the MCP preview tool saves to chat, not disk; this gives real
 * files for the deck). Drives the LIVE wallet preview at :5175 (BFF on :8791).
 *
 *   node scripts/capture-demo-screens.mjs
 *
 * Mobile viewport (iPhone-ish) so it matches the demo. Read-only navigation +
 * form-fill to the confirm step — it does NOT submit real txns (the real-USDC
 * settlement is captured separately during the live e2e), so it's safe to re-run.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/demo-flow/screens");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.WALLET_URL || "http://localhost:5175";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shots = [];
async function shot(page, name) {
  await sleep(900); // let the canvas + framer-motion settle
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(name);
  console.log("  captured", name);
}

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // 1) fresh new-user: clear onboarding flag so the signup splash shows
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("benzo.onboarded"));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await shot(page, "01_onboarding_welcome");

  // walk signup (Get started -> auth -> handle) best-effort
  try { await page.getByText("Get started").click({ timeout: 4000 }); await shot(page, "02_onboarding_auth"); } catch {}

  // 2) skip to the app for the rest of the screens
  await page.evaluate(() => localStorage.setItem("benzo.onboarded", "1"));
  const screens = [
    ["/", "03_home"],
    ["/cash", "04_cash_add_money"],
    ["/deposit", "07_deposit_import_qr"],
    ["/send", "09_send"],
    ["/request", "12_request"],
    ["/invite", "13_invite"],
    ["/activity", "20_activity"],
    ["/profile", "21_profile"],
    ["/share-proof", "22_share_proof"],
  ];
  for (const [path, name] of screens) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await shot(page, name);
    } catch (e) {
      console.log("  skip", name, String(e).slice(0, 80));
    }
  }

  await browser.close();
  console.log(`\nDone. ${shots.length} screens -> docs/demo-flow/screens/`);
};

run().catch((e) => { console.error(e); process.exit(1); });
