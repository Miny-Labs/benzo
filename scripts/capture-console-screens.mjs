/**
 * Capture the FULL business-console demo screen set to
 * docs/demo-flow/console-screens/*.png for the Benzo-for-Business deck.
 * Drives the live console preview at :5174 (BFF :8790, live testnet).
 *
 *   node scripts/capture-console-screens.mjs
 *
 * Desktop viewport (the console is desktop-only). Read-only navigation + a few
 * safe interactions (open CSV modal, generate prove-balance / disclose-total,
 * open a grant/invite form) — no value-moving txns, so it is safe to re-run.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/demo-flow/console-screens");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.CONSOLE_URL || "http://localhost:5174";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const page = await ctx.newPage();

async function shot(name, ms = 1200) {
  await sleep(ms);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("  captured", name);
}
async function go(path) {
  await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => {});
  await sleep(400);
}

// ---- 1. Onboarding + KYB (fresh org) -----------------------------------
try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("benzo.console.onboarded"));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await shot("01_onboarding_org");
  // advance through the wizard, best-effort, screenshotting each step
  for (let i = 2; i <= 6; i++) {
    const btn = page.getByRole("button", { name: /continue|next|verify|register|finish|review|create/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await sleep(1400);
      await shot(`0${i}_onboarding_step${i}`);
    }
  }
} catch (e) { console.log("  (onboarding skip)", e.message); }

// mark onboarded for the rest of the walkthrough
await page.evaluate(() => localStorage.setItem("benzo.console.onboarded", "1"));

// ---- 2. The core screens (read-only nav) -------------------------------
const screens = [
  ["/", "10_dashboard"],
  ["/contractors", "11_contractors"],
  ["/payroll", "12_payroll"],
  ["/approvals", "13_approvals_maker_checker"],
  ["/policies", "14_approval_policy_transfer_org"],
  ["/invoices", "15_invoices_ap"],
  ["/pay", "16_send_vendor_pay"],
  ["/treasury", "17_treasury_fund_prove"],
  ["/grants", "18_auditor_grants"],
  ["/invites", "19_invites_roles"],
  ["/settings", "20_settings_roles_matrix"],
];
for (const [path, name] of screens) {
  await go(path);
  await shot(name);
}

// ---- 3. Safe interactions that show the moat ---------------------------
// 3a. Treasury: generate a prove-balance + disclose-total (read-only proofs)
try {
  await go("/treasury");
  await page.getByTestId("prove-balance").click({ timeout: 5000 });
  await page.getByTestId("prove-result").waitFor({ timeout: 30000 });
  await shot("17b_treasury_prove_balance_result", 600);
} catch (e) { console.log("  (skip prove-balance)", e.message); }
try {
  await page.getByTestId("prove-total").click({ timeout: 5000 });
  await page.getByTestId("prove-total-result").waitFor({ timeout: 30000 });
  await shot("17c_treasury_disclose_total_result", 600);
} catch (e) { console.log("  (skip prove-total)", e.message); }

// 3b. Contractors: open the CSV import modal (rate-card roster)
try {
  await go("/contractors");
  await page.getByRole("button", { name: /import csv|import/i }).first().click({ timeout: 5000 });
  await shot("11b_contractors_csv_import", 700);
} catch (e) { console.log("  (skip csv modal)", e.message); }

// 3c. Auditor grants: open the new-grant form (scoped view key)
try {
  await go("/grants");
  await page.getByRole("button", { name: /new grant|grant|issue/i }).first().click({ timeout: 5000 });
  await shot("18b_auditor_grant_form", 700);
} catch (e) { console.log("  (skip grant form)", e.message); }

// 3d. Invites: the three role tabs (member / contractor / customer)
try {
  await go("/invites");
  for (const tab of ["Contractors", "Customers"]) {
    const t = page.getByRole("button", { name: new RegExp(tab, "i") }).first();
    if (await t.isVisible().catch(() => false)) { await t.click().catch(() => {}); await shot(`19_${tab.toLowerCase()}_invite`, 600); }
  }
} catch (e) { console.log("  (skip invite tabs)", e.message); }

await browser.close();
console.log("done — screens in docs/demo-flow/console-screens/");
