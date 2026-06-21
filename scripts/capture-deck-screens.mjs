/**
 * Capture the FULL consumer-app demo screen set to docs/demo-flow/screens/*.png
 * for the demo deck. Drives the live wallet preview at :5175 (BFF :8791, which is
 * running with BENZO_DEV_EXPORT=1 so the on-device proof path works).
 *
 *   node scripts/capture-deck-screens.mjs
 *
 * Mobile viewport for the clean, readable per-screen flow + the on-device proof
 * overlay (the "mobile proving" slot); a desktop hero shot to show the new video
 * backdrop behind the phone. Read-only navigation + the genuine on-device proof
 * (no value-moving txns), so it is safe to re-run.
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

async function shot(page, name, ms = 1100) {
  await sleep(ms);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("  captured", name);
}

const browser = await chromium.launch();

// ---------- MOBILE: clean, readable per-screen flow ----------
const m = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
const page = await m.newPage();

// 1) fresh new-user: clear onboarding so the signup splash shows
await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.removeItem("benzo.onboarded"));
await page.goto(BASE, { waitUntil: "networkidle" });
await shot(page, "01_onboarding_welcome");
try { await page.getByText("Get started").first().click({ timeout: 4000 }); await shot(page, "02_onboarding_auth"); }
catch (e) { console.log("  (skip 02)", e.message); }

// 2) into the app for the rest
await page.evaluate(() => localStorage.setItem("benzo.onboarded", "1"));
const simple = [
  ["/", "03_home"],
  ["/cash", "04_cash_add_money"],
  ["/cash?tab=out", "05_cash_cashout"],
  ["/deposit", "07_deposit_import_qr"],
  ["/send", "09_send"],
  ["/request", "12_request"],
  ["/invite", "13_invite"],
  ["/claim", "14_claim_signup"],
  ["/activity", "20_activity"],
  ["/profile", "21_profile"],
  ["/share-proof", "22_share_proof"],
];
for (const [path, name] of simple) {
  try { await page.goto(BASE + path, { waitUntil: "networkidle" }); await shot(page, name); }
  catch (e) { console.log("  (skip)", name, e.message); }
}

// 3) send confirm (best-effort fill → review)
try {
  await page.goto(BASE + "/send", { waitUntil: "networkidle" });
  await page.getByTestId("send-handle").fill("alicepay");
  await page.locator("input").nth(1).fill("1").catch(() => {});
  await page.getByTestId("send-submit").click({ timeout: 5000 });
  await page.getByTestId("send-confirm").waitFor({ timeout: 5000 });
  await shot(page, "10_send_confirm");
} catch (e) { console.log("  (skip 10_send_confirm)", e.message); }

// 4) tx detail = the "Advanced / on-chain receipt" (chain-scan link) disclosure
try {
  await page.goto(BASE + "/activity", { waitUntil: "networkidle" });
  await sleep(1600);
  await page.locator("main button").first().click({ timeout: 5000 });
  await page.getByTestId("txdetail-amount").waitFor({ timeout: 8000 });
  await shot(page, "23_txdetail_onchain");
} catch (e) { console.log("  (skip 23_txdetail)", e.message); }

// 5) on-device proof overlay (mobile viewport = the "mobile proving" slot)
try {
  await page.goto(BASE + "/share-proof", { waitUntil: "networkidle" });
  await page.locator("input").first().fill("5");
  await page.getByTestId("proof-generate").click({ timeout: 5000 });
  await page.getByTestId("proof-overlay").waitFor({ timeout: 35000 });
  await shot(page, "19_proving_mobile", 900);
} catch (e) { console.log("  (skip 19_proving_mobile)", e.message); }

await m.close();

// ---------- DESKTOP: hero shot showing the new video backdrop behind the phone ----------
try {
  const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const dp = await d.newPage();
  await dp.goto(BASE, { waitUntil: "networkidle" });
  await dp.evaluate(() => localStorage.setItem("benzo.onboarded", "1"));
  await dp.goto(BASE + "/", { waitUntil: "networkidle" });
  await shot(dp, "00_hero_home_backdrop", 1800);
  await d.close();
} catch (e) { console.log("  (skip 00_hero)", e.message); }

await browser.close();
console.log("done");
