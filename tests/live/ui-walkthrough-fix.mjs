/** Targeted re-run of the 3 flows that needed the right interaction — LIVE, real USDC. */
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { homedir } from "node:os";
const WALLET = "http://localhost:5175", CONSOLE = "http://localhost:5174";
const DIR = join(homedir(), "Desktop", "benzo-live-walkthrough");
const HANDLE = process.env.SMOKE_HANDLE || "benzowallet";
const shot = async (p, name) => { await p.screenshot({ path: join(DIR, name) }); console.log("📸", name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = async (l, fn) => { try { await fn(); } catch (e) { console.log("⚠️", l, "—", String(e.message).split("\n")[0].slice(0, 90)); } };

const browser = await chromium.launch();

// 1) Cash → Add money (real shield) — button testid is add-submit
await safe("cash add", async () => {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { localStorage.setItem("benzo.onboarded", "1"); localStorage.setItem("benzo.hidden", "0"); });
  const p = await ctx.newPage();
  await p.goto(WALLET + "/cash", { waitUntil: "networkidle" });
  await wait(800);
  await p.getByLabel("Amount").fill("0.10");
  await p.getByTestId("add-submit").click();
  await p.waitForSelector('[data-testid="cash-overlay"]', { timeout: 10000 });
  await wait(11000); // real shield settle
  await shot(p, "05b-wallet-cash-added.png");
  await ctx.close();
});

// 2) Share proof — prove a min the wallet ACTUALLY holds ($0.10), so the proof is true
await safe("share proof", async () => {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { localStorage.setItem("benzo.onboarded", "1"); localStorage.setItem("benzo.hidden", "0"); });
  const p = await ctx.newPage();
  await p.goto(WALLET + "/share-proof", { waitUntil: "networkidle" });
  await wait(800);
  await p.getByLabel("Amount").fill("0.10");
  await p.getByTestId("proof-generate").click();
  await p.waitForSelector('[data-testid="proof-success"]', { timeout: 90000 });
  await wait(500);
  await shot(p, "19b-wallet-share-proof-success.png");
  await ctx.close();
});

// 3) Console Pay a contractor (real settle) — needs From account + handle + amount
await safe("console pay", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 880 } });
  await ctx.addInitScript(() => { localStorage.setItem("benzo.console.onboarded", "1"); localStorage.setItem("benzo.masked", "0"); });
  const p = await ctx.newPage();
  await p.goto(CONSOLE + "/pay", { waitUntil: "networkidle" });
  await wait(800);
  await p.getByTestId("pay-from").selectOption({ index: 1 });
  await p.getByTestId("pay-handle").fill("@" + HANDLE);
  await p.getByTestId("pay-amount").fill("0.02");
  await wait(300);
  await shot(p, "30b-console-pay-form.png");
  await p.getByTestId("pay-submit").click();
  await p.waitForSelector('[data-testid="pay-result"]', { timeout: 90000 });
  await wait(500);
  await shot(p, "31b-console-pay-result.png");
  await ctx.close();
});

await browser.close();
console.log("✅ fix run complete");
