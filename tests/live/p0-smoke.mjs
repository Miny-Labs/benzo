/**
 * P0 LIVE smoke — real USDC moving on testnet, driving the exact BFF endpoints
 * the consumer wallet UI uses. Proves the whole S1→P0-3 chain end-to-end:
 *   claim handle (on-chain register) → add money (shield) → send to @handle
 *   (shielded) → send to a G-address (unshield) → invite (claim-link) → claim
 *   (sweep) → post-claim send (MVK-mirror recovery).
 *
 * Prereq: the wallet-api running LIVE on :8791
 *   set -a; . ./.env; set +a; WALLET_API_PORT=8791 node apps/wallet-api/dist/server.js
 * Optional: SMOKE_GADDR=<G-address> to exercise the public-payout (unshield) path.
 *
 * Usage: node tests/live/p0-smoke.mjs
 */
const BASE = process.env.SMOKE_BASE ?? "http://localhost:8791";
const GADDR = process.env.SMOKE_GADDR;
const HANDLE = process.env.SMOKE_HANDLE ?? "benzowallet";

let failures = 0;
const log = (m) => process.stdout.write(m + "\n");
function check(name, cond, detail) {
  log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
async function api(path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status} on ${path}`);
  return j;
}
const usd = (stroops) => `$${(Number(stroops) / 1e7).toFixed(2)}`;

const session = await api("/session");
check("BFF is LIVE on testnet", session.live === true, `mode=${session.mode}`);
if (!session.live) {
  log("\nAborting: BFF is in demo mode. Start it with .env loaded.");
  process.exit(1);
}

// 1) claim handle (on-chain register)
const h = await api("/handle/claim", { handle: HANDLE });
check("claim handle (on-chain register)", h.onChain === true, `@${h.handle} tx=${h.txHash?.slice(0, 10)}`);

// 2) add money (real shield)
const before = Number((await api("/balance")).stroops);
const add = await api("/add-money", { amount: "0.30" });
check("add money — shield settled on-chain", add.onChain === true && add.status === "settled", `tx=${add.txHash?.slice(0, 10)}`);
const afterAdd = Number((await api("/balance")).stroops);
check("balance increased after shield", afterAdd > before, `${usd(before)} → ${usd(afterAdd)}`);

// 3) send to @handle (shielded, private)
const s1 = await api("/send", { to: `@${HANDLE}`, amount: "0.05", memo: "smoke" });
check("send to @handle — shielded settle on-chain", s1.onChain === true && s1.status === "settled", `tx=${s1.txHash?.slice(0, 10)} proved in ${s1.provingMs}ms`);

// 4) send to a G-address (public payout via unshield) — optional
if (GADDR) {
  const s2 = await api("/send", { to: GADDR, amount: "0.05" });
  check("send to G-address — unshield settle on-chain", s2.onChain === true && s2.status === "settled", `tx=${s2.txHash?.slice(0, 10)}`);
} else {
  log("• (skipped G-address payout — set SMOKE_GADDR to include it)");
}

// 5) invite (fund a claim-link)
const inv = await api("/invite", { amount: "0.05", note: "smoke invite" });
check("create invite — claim-link funded on-chain", inv.onChain === true && inv.link.includes("app=consumer"), `localId=${inv.localId}`);
const secret = inv.link.split("#")[1];

// 6) claim it (sweep the link account)
const cl = await api("/claim", { secret });
check("claim invite — sweep settled on-chain", cl.onChain === true && Number(cl.amount) > 0, `${usd(cl.amount)} tx=${cl.txHash?.slice(0, 10)}`);

// 7) post-claim send — proves the wallet account + MVK mirror recovered
const s3 = await api("/send", { to: `@${HANDLE}`, amount: "0.02" });
check("post-claim send — wallet/MVK recovered", s3.onChain === true && s3.status === "settled", `tx=${s3.txHash?.slice(0, 10)}`);

log(`\nfinal balance: ${usd((await api("/balance")).stroops)}`);
log(failures === 0 ? "\nALL LIVE SMOKE CHECKS PASSED ✓ (real USDC moved on testnet)" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
