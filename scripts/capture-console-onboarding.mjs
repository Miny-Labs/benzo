/**
 * Capture the business ONBOARDING + KYB wizard cleanly. Flow:
 * SSO (ZK-login) -> org -> KYB (on-chain) -> compliance -> team ->
 * treasury keys (on-chain register_mvk) -> review. Uses evaluate-clicks +
 * waitForSelector (robust headless) → docs/demo-flow/console-screens.
 *
 *   node scripts/capture-console-onboarding.mjs
 */
import { chromium } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/demo-flow/console-screens");
const BASE = process.env.CONSOLE_URL || "http://localhost:5174";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();
const shot = async (n, ms = 900) => { await sleep(ms); await page.screenshot({ path: join(OUT, `${n}.png`) }); console.log("  captured", n); };
const clickTid = (tid) => page.evaluate((t) => { const el = document.querySelector(`[data-testid=${t}]`); if (el) el.click(); return !!el; }, tid);
const waitTid = (tid, timeout = 12000) => page.waitForSelector(`[data-testid=${tid}]`, { timeout }).catch(() => null);
const fillTid = (tid, v) => page.evaluate(({ t, v }) => { const el = document.querySelector(`[data-testid=${t}]`); if (el) { el.value = ""; el.focus(); } }, { t: tid, v }).then(() => page.fill(`[data-testid=${tid}]`, v).catch(() => {}));
const nextStep = async () => { await clickTid("wizard-next"); await sleep(1300); };

await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.removeItem("benzo.console.onboarded"));
await page.goto(BASE, { waitUntil: "networkidle" });
await sleep(1000);

// Step 0 — SSO / ZK-login
await shot("01_onboarding_signup");
await clickTid("auth-google");
await waitTid("org-name");

// Step 1 — Org
await fillTid("org-name", "Acme Robotics");
await fillTid("org-legal", "Acme Robotics Inc.");
await shot("02_onboarding_org");
await nextStep();

// Step 2 — KYB (real on-chain attestation)
await shot("03_onboarding_kyb");
await clickTid("kyb-run");
await waitTid("kyb-verifying", 4000);
await shot("03b_onboarding_kyb_verifying", 400);
await waitTid("kyb-result", 60000);
await shot("04_onboarding_kyb_result", 600);
await nextStep();

// Step 3 — Compliance zone
await shot("05_onboarding_zone");
await page.evaluate(() => { const b = Array.from(document.querySelectorAll("main button")).find((x) => /US|United States|EU|Europe/i.test(x.textContent || "")); if (b) b.click(); });
await nextStep();

// Step 4 — Team
await shot("06_onboarding_team");
await nextStep();

// Step 5 — Treasury keys (real register_mvk on-chain)
await shot("07_onboarding_treasury_keys");
await clickTid("mvk-register");
await sleep(9000);
await shot("07b_onboarding_keys_done", 400);
await nextStep();

// Step 6 — Review
await shot("08_onboarding_review");

await browser.close();
console.log("done");
