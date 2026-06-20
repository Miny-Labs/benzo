/**
 * LIVE no-mock UI walkthrough — drives BOTH apps as a real user against testnet,
 * moving REAL USDC through every path, and saves a numbered screenshot of each
 * step to ~/Desktop/benzo-live-walkthrough/.
 *
 * Prereq (all LIVE):
 *   set -a; . ./.env; set +a
 *   WALLET_API_PORT=8791 node apps/wallet-api/dist/server.js &
 *   CONSOLE_API_PORT=8790 node apps/console-api/dist/server.js &
 *   pnpm --filter @benzo/wallet-app dev &      # :5175
 *   pnpm --filter @benzo/console dev &          # :5174
 *   SMOKE_GADDR=$(stellar keys address benzo-deployer) node tests/live/ui-walkthrough.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WALLET = "http://localhost:5175";
const CONSOLE = "http://localhost:5174";
const DIR = join(homedir(), "Desktop", "benzo-live-walkthrough");
mkdirSync(DIR, { recursive: true });
const GADDR = process.env.SMOKE_GADDR || (() => { try { return readFileSync("/tmp/gaddr.txt", "utf8").trim(); } catch { return ""; } })();
const HANDLE = process.env.SMOKE_HANDLE || "benzowallet";

let n = 0;
const shot = async (page, name) => {
  const f = join(DIR, `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: f });
  console.log("📸", `${String(n).padStart(2, "0")}-${name}.png`);
};
const safe = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log("⚠️ ", label, "—", String(e.message).split("\n")[0].slice(0, 100));
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

// ============================================================ CONSUMER WALLET
console.log("\n=== CONSUMER WALLET (mobile, LIVE) ===");

// -- onboarding (fresh, first-run) --
await safe("wallet onboarding", async () => {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(WALLET, { waitUntil: "networkidle" });
  await p.waitForSelector('[data-testid="onboarding"]', { timeout: 15000 });
  await wait(900);
  await shot(p, "wallet-onboarding-welcome");
  await p.getByTestId("onboarding-cta").click();
  await wait(700);
  await shot(p, "wallet-onboarding-signin");
  await p.getByTestId("auth-google").click();
  await wait(1200);
  await p.getByTestId("handle-input").fill("acmepay");
  await wait(1200); // availability check
  await shot(p, "wallet-onboarding-claim-handle");
  await ctx.close();
});

// -- main app (onboarded) --
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  localStorage.setItem("benzo.onboarded", "1");
  localStorage.setItem("benzo.hidden", "0");
});
const w = await ctx.newPage();

await safe("wallet home", async () => {
  await w.goto(WALLET, { waitUntil: "networkidle" });
  await wait(1500); // balance loads from chain + count-up
  await shot(w, "wallet-home");
});

// -- Add money (REAL shield) --
await safe("wallet cash add (real shield)", async () => {
  await w.goto(WALLET + "/cash", { waitUntil: "networkidle" });
  await wait(800);
  await w.getByLabel("Amount").fill("0.10");
  await shot(w, "wallet-cash-addmoney");
  await w.getByTestId("add-money").click();
  await w.waitForSelector('[data-testid="cash-overlay"]', { timeout: 10000 });
  await wait(9000); // real shield settle
  await shot(w, "wallet-cash-added");
});

// -- Send to @handle (REAL shielded transfer + 3-phase ceremony) --
await safe("wallet send to handle (real)", async () => {
  await w.goto(WALLET + "/send", { waitUntil: "networkidle" });
  await wait(600);
  await w.getByTestId("send-handle").fill("@" + HANDLE);
  await w.getByLabel("Amount").fill("0.02");
  await wait(400);
  await shot(w, "wallet-send-form");
  await w.getByTestId("send-submit").click(); // review
  await wait(500);
  await shot(w, "wallet-send-confirm");
  await w.getByTestId("send-confirm").click(); // fire
  await w.waitForSelector('[data-testid="send-overlay"]', { timeout: 10000 });
  await wait(2500);
  await shot(w, "wallet-send-ceremony");
  await w.waitForSelector('[data-testid="ceremony-done"]', { timeout: 60000 });
  await shot(w, "wallet-send-receipt");
  await w.getByTestId("ceremony-done").click();
});

// -- Send to a Stellar G-address (REAL public payout / unshield) --
await safe("wallet send to address (real)", async () => {
  if (!GADDR) throw new Error("no G-address");
  await w.goto(WALLET + "/send", { waitUntil: "networkidle" });
  await wait(600);
  await w.getByTestId("send-handle").fill(GADDR);
  await w.getByLabel("Amount").fill("0.02");
  await wait(400);
  await shot(w, "wallet-send-address-kind"); // shows "public payout — leaves the shield"
  await w.getByTestId("send-submit").click();
  await wait(500);
  await w.getByTestId("send-confirm").click();
  await w.waitForSelector('[data-testid="ceremony-done"]', { timeout: 60000 });
  await shot(w, "wallet-send-address-receipt");
  await w.getByTestId("ceremony-done").click();
});

// -- Invite an external person (REAL claim-link funded) → then claim it (REAL) --
await safe("wallet invite + claim (real)", async () => {
  await w.goto(WALLET + "/invite", { waitUntil: "networkidle" });
  await wait(600);
  await w.getByLabel("Amount").fill("0.02");
  await shot(w, "wallet-invite-form");
  await w.getByTestId("invite-create").click();
  await w.waitForSelector('[data-testid="invite-link"]', { timeout: 60000 });
  await wait(500);
  await shot(w, "wallet-invite-link");
  const link = (await w.getByTestId("invite-link").innerText()).trim();
  // claim it back (real sweep)
  await w.goto(WALLET + "/claim?link=" + encodeURIComponent(link), { waitUntil: "networkidle" });
  await w.waitForSelector('[data-testid="claim-accept"]', { timeout: 10000 });
  await shot(w, "wallet-claim-landing");
  await w.getByTestId("claim-accept").click();
  await w.waitForSelector('[data-testid="claim-done"]', { timeout: 60000 });
  await shot(w, "wallet-claim-done");
});

// -- Wrong-app boundary (a business invite bounces here) --
await safe("wallet wrong-app", async () => {
  const biz = "benzo://org?o=org_acme&kind=member&app=business#tok";
  await w.goto(WALLET + "/claim?link=" + encodeURIComponent(biz), { waitUntil: "networkidle" });
  await w.waitForSelector('[data-testid="claim-mismatch"]', { timeout: 8000 });
  await shot(w, "wallet-wrong-app");
});

// -- Request, Activity, Profile, Share-proof --
await safe("wallet request", async () => {
  await w.goto(WALLET + "/request", { waitUntil: "networkidle" });
  await wait(800);
  await shot(w, "wallet-request");
});
await safe("wallet activity", async () => {
  await w.goto(WALLET + "/activity", { waitUntil: "networkidle" });
  await wait(1500);
  await shot(w, "wallet-activity");
});
await safe("wallet share-proof", async () => {
  await w.goto(WALLET + "/share-proof", { waitUntil: "networkidle" });
  await wait(800);
  await safe("generate proof", async () => {
    await w.getByTestId("proof-generate").click();
    await w.waitForSelector('[data-testid="proof-success"]', { timeout: 60000 });
  });
  await shot(w, "wallet-share-proof");
});
await safe("wallet profile", async () => {
  await w.goto(WALLET + "/profile", { waitUntil: "networkidle" });
  await wait(800);
  await shot(w, "wallet-profile");
});

await ctx.close();

// ============================================================ BUSINESS CONSOLE
console.log("\n=== BUSINESS CONSOLE (desktop, LIVE) ===");

// -- onboarding wizard (fresh) --
await safe("console onboarding", async () => {
  const c0 = await browser.newContext({ viewport: { width: 1280, height: 880 } });
  const p = await c0.newPage();
  await p.goto(CONSOLE, { waitUntil: "networkidle" });
  await p.waitForSelector('[data-testid="console-onboarding"]', { timeout: 15000 });
  await wait(700);
  await shot(p, "console-onboarding-signin");
  await p.getByTestId("auth-google").click();
  await wait(700);
  await p.getByTestId("org-name").fill("Acme Robotics");
  await p.getByTestId("org-legal").fill("Acme Robotics Inc.");
  await shot(p, "console-onboarding-org");
  await p.getByTestId("wizard-next").click();
  await wait(400);
  await p.getByTestId("kyb-run").click();
  await p.waitForSelector('[data-testid="kyb-result"]', { timeout: 10000 });
  await shot(p, "console-onboarding-kyb");
  await p.getByTestId("wizard-next").click(); // → zone
  await wait(300);
  await p.getByTestId("wizard-next").click(); // → team
  await wait(300);
  await p.getByTestId("wizard-next").click(); // → treasury
  await wait(300);
  await safe("register MVK (real)", async () => {
    await p.getByTestId("mvk-register").click();
    await p.waitForSelector('[data-testid="mvk-result"]', { timeout: 60000 });
  });
  await shot(p, "console-onboarding-treasury");
  await p.getByTestId("wizard-next").click(); // → review
  await wait(400);
  await shot(p, "console-onboarding-review");
  await c0.close();
});

// -- main console (onboarded) --
const cctx = await browser.newContext({ viewport: { width: 1280, height: 880 } });
await cctx.addInitScript(() => {
  localStorage.setItem("benzo.console.onboarded", "1");
  localStorage.setItem("benzo.masked", "0");
});
const c = await cctx.newPage();

const screen = async (path, name, settle = 1200) => {
  await safe(name, async () => {
    await c.goto(CONSOLE + path, { waitUntil: "networkidle" });
    await wait(settle);
    await shot(c, name);
  });
};
await screen("/", "console-dashboard");
await screen("/contractors", "console-contractors");
await screen("/payroll", "console-payroll");
await screen("/invoices", "console-invoices");

// -- Pay a contractor (REAL org → contractor settlement) --
await safe("console pay contractor (real)", async () => {
  await c.goto(CONSOLE + "/pay", { waitUntil: "networkidle" });
  await wait(800);
  await shot(c, "console-pay-form");
  await safe("fill + submit pay", async () => {
    await c.getByTestId("pay-handle").fill("@" + HANDLE);
    await c.getByTestId("pay-amount").fill("0.02");
    await c.getByTestId("pay-submit").click();
    await c.waitForSelector('[data-testid="pay-result"]', { timeout: 60000 });
  });
  await shot(c, "console-pay-result");
});

await screen("/approvals", "console-approvals");

// -- Treasury prove-balance (real proof) --
await safe("console treasury prove", async () => {
  await c.goto(CONSOLE + "/treasury", { waitUntil: "networkidle" });
  await wait(1000);
  await shot(c, "console-treasury");
  await safe("prove", async () => {
    await c.getByTestId("prove-min").fill("0.10");
    await c.getByTestId("prove-balance").click();
    await c.waitForSelector('[data-testid="prove-result"]', { timeout: 60000 });
    await shot(c, "console-treasury-proof");
  });
});

await screen("/grants", "console-grants");

// -- Invites (business-scoped link) --
await safe("console invites", async () => {
  await c.goto(CONSOLE + "/invites", { waitUntil: "networkidle" });
  await wait(800);
  await safe("create contractor invite", async () => {
    await c.getByTestId("invite-tab-contractor").click();
    await c.getByTestId("invite-name").fill("Grace Hopper");
    await c.getByTestId("invite-create").click();
    await c.waitForSelector('[data-testid="invite-link"]', { timeout: 10000 });
  });
  await shot(c, "console-invites");
});

await screen("/settings", "console-settings");

await cctx.close();
await browser.close();
console.log(`\n✅ walkthrough complete — ${n} screenshots saved to ${DIR}`);
