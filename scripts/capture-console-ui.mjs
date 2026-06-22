/**
 * Standalone screenshot capture for the business console UI report (B-UI8).
 * Connects to the ALREADY-RUNNING console dev server (:5174) + console-api (:8790)
 * — it does NOT start or stop any server. Drives each screen, triggers the ZK /
 * settlement actions, and writes PNGs to docs/console-ui-report/shots/.
 *
 * Run: node scripts/capture-console-ui.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/console-ui-report/shots");
mkdirSync(OUT, { recursive: true });

const BASE = "http://localhost:5174";
const captured = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    localStorage.setItem("benzo.masked", "0");
    localStorage.setItem("benzo.console.onboarded", "1");
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  const shot = async (name) => {
    const p = join(OUT, `${name}.png`);
    await page.screenshot({ path: p });
    captured.push(name);
    console.log("  shot:", name);
  };
  const safe = async (label, fn) => {
    try { await fn(); } catch (e) { console.log(`  ! ${label}: ${(e.message || e).toString().split("\n")[0]}`); }
  };
  const go = async (path, heading) => {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
    if (heading) await page.getByRole("heading", { name: heading }).first().waitFor({ timeout: 15000 }).catch(() => {});
    await sleep(900); // let the page enter-animation settle
  };

  // 1. Dashboard — equal-height hero cards + full-width topbar
  await safe("dashboard", async () => { await go("/", "Overview"); await shot("01-dashboard"); });

  // 2. Treasury — 4 equal prove cards; reserves prove → Proving → Reveal → OnChainDetail
  await safe("treasury", async () => {
    await go("/treasury", "Treasury");
    await shot("02-treasury");
    const btn = page.getByTestId("prove-balance").first();
    if (await btn.count()) {
      await btn.click();
      await sleep(450); await shot("03-treasury-proving"); // in-flight ZK motion
      await page.getByTestId("view-onchain").first().waitFor({ timeout: 90000 }).catch(() => {});
      await sleep(400); await shot("04-treasury-revealed");
      const v = page.getByTestId("view-onchain").first();
      if (await v.count()) { await v.click(); await page.getByTestId("onchain-modal").waitFor({ timeout: 8000 }).catch(() => {}); await sleep(400); await shot("05-treasury-onchain-modal"); await page.keyboard.press("Escape").catch(() => {}); }
    }
  });

  // 3. Auditor grants — period-total + KYB credential
  await safe("grants", async () => {
    await go("/grants", "Auditor grants");
    await shot("06-grants");
    const kyb = page.getByTestId("prove-kyb").first();
    if (await kyb.count()) {
      await kyb.click();
      await sleep(450); await shot("07-grants-kyb-proving");
      await page.getByTestId("kyb-result").waitFor({ timeout: 90000 }).catch(() => {});
      await sleep(400); await shot("08-grants-kyb-revealed");
    }
  });

  // 4. Payroll — proof badges + in-flight Proving strip + payslips link
  await safe("payroll", async () => {
    await go("/payroll", "Payroll");
    await shot("09-payroll");
    const funded = page.getByTestId("check-funded").first();
    if (await funded.count()) { await funded.click(); await sleep(500); await shot("10-payroll-proving"); }
  });

  // 5. Invoices — cross-entity netting → Proving → Reveal
  await safe("invoices", async () => {
    await go("/invoices", "Invoices to pay");
    await shot("11-invoices");
    const net = page.getByTestId("net-invoices").first();
    if (await net.count()) {
      await net.click();
      await sleep(450); await shot("12-invoices-net-proving");
      await page.getByTestId("net-result").waitFor({ timeout: 90000 }).catch(() => {});
      await sleep(400); await shot("13-invoices-net-revealed");
    }
  });

  // 6. Contractors — equal-height stats + per-contractor pay history expand
  await safe("contractors", async () => {
    await go("/contractors", "Contractors");
    await shot("14-contractors");
    const hist = page.getByTestId("contractor-history").first();
    if (await hist.count()) { await hist.click(); await page.getByTestId("contractor-history-row").first().waitFor({ timeout: 8000 }).catch(() => {}); await sleep(400); await shot("15-contractors-history"); }
  });

  // 7. Audit log — tamper-evidence verify (instant, reliable) → Reveal
  await safe("audit", async () => {
    await go("/audit", "Audit log");
    await shot("16-audit");
    const v = page.getByTestId("verify-chain").first();
    if (await v.count()) { await v.click(); await page.getByTestId("integrity-result").waitFor({ timeout: 15000 }).catch(() => {}); await sleep(400); await shot("17-audit-verified"); }
  });

  // 8. Approvals + Policies + Settings + Invites — render coverage
  await safe("approvals", async () => { await go("/approvals", "Approvals"); await shot("18-approvals"); });
  await safe("policies", async () => { await go("/policies", "Approval policies"); await shot("19-policies"); });
  await safe("settings", async () => { await go("/settings", "Settings"); await shot("20-settings"); });
  await safe("invites", async () => { await go("/invites", "Invites"); await shot("21-invites"); });
  await safe("pay", async () => { await go("/pay", "Send"); await shot("22-pay"); });

  await browser.close();
  console.log(`\nCaptured ${captured.length} screenshots to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
