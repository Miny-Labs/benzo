/**
 * P0-B (Act 2) LIVE smoke — a business pays a contractor real USDC on testnet
 * through the AP invoice → confidential settlement engine the console UI uses:
 *   set contractor @handle → submit invoice → pay → shielded settle on-chain.
 *
 * Prereq: console-api running LIVE on :8790
 *   set -a; . ./.env; set +a; CONSOLE_API_PORT=8790 node apps/console-api/dist/server.js
 * Optional: SMOKE_HANDLE=<registered @handle the org pays> (default benzowallet).
 *
 * Usage: node tests/live/p0b-smoke.mjs
 */
const BASE = process.env.SMOKE_BASE ?? "http://localhost:8790";
const HANDLE = process.env.SMOKE_HANDLE ?? "benzowallet";
const AMOUNT_STROOPS = process.env.SMOKE_AMOUNT ?? "300000"; // $0.03

let failures = 0;
const log = (m) => process.stdout.write(m + "\n");
function check(name, cond, detail) {
  log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
async function api(path, body, method) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status} on ${path}`);
  return j;
}
const usd = (s) => `$${(Number(s) / 1e7).toFixed(2)}`;

const live = await api("/live");
check("console-api is LIVE on testnet", live.live === true, `mode=${live.mode}`);
if (!live.live) {
  log("\nAborting: console-api is in demo mode. Start it with .env loaded.");
  process.exit(1);
}

const treasury = await api("/treasury");
const bal = Number(treasury.totalHidden.amount);
check("org treasury is funded", bal >= Number(AMOUNT_STROOPS), `balance ${usd(bal)}, paying ${usd(AMOUNT_STROOPS)}`);

// pick a contractor + set the @handle the org will pay
const cps = await api("/counterparties");
const cp = cps.find((c) => c.type === "contractor") ?? cps[0];
check("found a contractor to pay", !!cp, cp?.name);
await api(`/counterparties/${cp.id}`, { handle: HANDLE }, "PATCH");
log(`• paying contractor "${cp.name}" at @${HANDLE}`);

// contractor submits a small invoice (under the $5k approval threshold → auto-settles)
const inv = await api("/invoices", {
  counterpartyId: cp.id,
  lineItems: [{ description: "Act 2 smoke — design", quantity: 1, unitAmount: AMOUNT_STROOPS }],
  assetCode: "USDC",
});
check("contractor invoice created", !!inv.id, `${inv.number} ${usd(inv.total.amount)}`);

// employer pays it through the engine
const paid = await api(`/invoices/${inv.id}/pay`, {});
const po = paid.payment;
const settledOnChain = po?.settlement?.onChain === true;
const txHash = po?.settlement?.txHash;
check("invoice paid → shielded settle on-chain", settledOnChain, txHash ? `tx=${txHash.slice(0, 10)}` : (paid.invoice?.status ?? po?.status));
check("invoice marked paid", paid.invoice?.status === "paid", paid.invoice?.status);

log(`\nfinal treasury: ${usd((await api("/treasury")).totalHidden.amount)}`);
log(failures === 0 ? "\nACT 2 LIVE SMOKE PASSED ✓ (org paid a contractor real USDC on testnet)" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
