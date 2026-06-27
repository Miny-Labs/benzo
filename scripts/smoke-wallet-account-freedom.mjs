#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../apps/wallet-api/package.json", import.meta.url));
const StellarSdk = require("@stellar/stellar-sdk");

const deployment = JSON.parse(readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"));
const apiOrigin = (process.env.WALLET_API_ORIGIN || "https://wallet.benzo.space").replace(/\/+$/, "");
const base = `${apiOrigin}/api`;
const secret = process.env.BENZO_TEST_AUTH_SECRET;
const usdcIssuer = process.env.USDC_ISSUER || String(deployment.usdcAsset || "USDC:").split(":")[1];
const amount = process.env.BENZO_SMOKE_AMOUNT || "5";

if (!secret) {
  throw new Error("BENZO_TEST_AUTH_SECRET is required. Load it from the live wallet API environment; this script never prints it.");
}
if (!usdcIssuer) throw new Error("USDC issuer is missing from deployments/testnet.json");

let token = "";

function explorer(txHash) {
  return txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null;
}

function stroopsToDecimal(stroops) {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = String(n % 10_000_000n).padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

async function api(path, { method = "GET", body, idem } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectApiStatus(path, expectedStatus, { method = "GET", body, idem } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== expectedStatus) {
    throw new Error(`${method} ${path} expected ${expectedStatus}, got ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function mintToken(subject) {
  const res = await fetch(base + "/auth/test", {
    method: "POST",
    headers: { "content-type": "application/json", "x-benzo-test-secret": secret },
    body: JSON.stringify({
      subject,
      email: `${subject}@benzo.local`,
      name: "Account Freedom Smoke",
      ttlSeconds: 3600,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`auth/test -> ${res.status} ${JSON.stringify(json)}`);
  return json.token;
}

async function createRecipientTrustline() {
  const kp = StellarSdk.Keypair.random();
  const horizon = new StellarSdk.Horizon.Server("https://horizon-testnet.stellar.org");
  const friendbot = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!friendbot.ok) throw new Error(`friendbot ${friendbot.status} ${await friendbot.text()}`);
  const account = await horizon.loadAccount(kp.publicKey());
  const asset = new StellarSdk.Asset("USDC", usdcIssuer);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  return { kp, horizon };
}

async function recipientUsdc(horizon, address) {
  const account = await horizon.loadAccount(address);
  const balance = account.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === usdcIssuer);
  return balance?.balance ?? "0";
}

async function waitFor(label, fn, { attempts = 18, delayMs = 3000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.ok) return last.value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} did not become true after ${attempts} attempts; last=${JSON.stringify(last)}`);
}

function assertEmptyFreshState({ privateBalance, publicBalance, history, contacts }) {
  if (privateBalance.stroops !== "0") throw new Error(`fresh private balance was ${privateBalance.stroops}`);
  if (publicBalance.stroops !== "0") throw new Error(`fresh public balance was ${publicBalance.stroops}`);
  if (history.length !== 0) throw new Error(`fresh history length was ${history.length}`);
  if (contacts.length !== 0) throw new Error(`fresh contacts length was ${contacts.length}`);
}

const run = Date.now().toString(36);
const subject = `funded-exit-${run}`;
const handle = `exit${run.slice(-8)}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);

console.log(`[wallet-smoke] api=${apiOrigin}`);
console.log(`[wallet-smoke] subject=${subject}`);
console.log(`[wallet-smoke] handle=@${handle}`);

token = await mintToken(subject);

const initialSession = await api("/session");
const initialPrivate = await api("/balance");
const initialPublic = await api("/public-balance");
const initialHistory = await api("/history");
const initialContacts = await api("/contacts");
console.log(`[wallet-smoke] initial handle=${initialSession.handle} private=${initialPrivate.stroops} public=${initialPublic.stroops} history=${initialHistory.length} contacts=${initialContacts.length}`);
assertEmptyFreshState({
  privateBalance: initialPrivate,
  publicBalance: initialPublic,
  history: initialHistory,
  contacts: initialContacts,
});

const availability = await api(`/handle/available?h=${encodeURIComponent(handle)}`);
if (!availability.available) throw new Error(`random handle unavailable: ${handle}`);
const claim = await api("/handle/claim", { method: "POST", body: { handle }, idem: `claim-${run}` });
console.log(`[wallet-smoke] claim tx=${claim.txHash || "none"} ${explorer(claim.txHash) || ""}`);

const deposit = await api("/deposit-address");
console.log(`[wallet-smoke] deposit address=${deposit.address}`);

const { kp: recipient, horizon } = await createRecipientTrustline();
console.log(`[wallet-smoke] external recipient=${recipient.publicKey()}`);
console.log(`[wallet-smoke] recipient initial USDC=${await recipientUsdc(horizon, recipient.publicKey())}`);

const add = await api("/add-money", { method: "POST", body: { amount, prover: "tee" }, idem: `add-${run}` });
console.log(`[wallet-smoke] add-money tx=${add.txHash || "none"} ${explorer(add.txHash) || ""}`);
const privateAfterAdd = await waitFor("private balance after add", async () => {
  const balance = await api("/balance");
  return { ok: BigInt(balance.stroops) >= 50_000_000n, value: balance };
});

const deleteWhileFunded = await expectApiStatus("/account", 409, {
  method: "DELETE",
  body: {},
  idem: `delete-funded-${run}`,
});
if (!deleteWhileFunded.blockers?.includes("private_balance")) {
  throw new Error(`delete did not block private funds: ${JSON.stringify(deleteWhileFunded)}`);
}
console.log(`[wallet-smoke] delete while funded refused blockers=${JSON.stringify(deleteWhileFunded.blockers)}`);

const makePublic = await api("/make-public", { method: "POST", body: { amount, prover: "tee" }, idem: `make-public-${run}` });
console.log(`[wallet-smoke] make-public tx=${makePublic.txHash || "none"} ${explorer(makePublic.txHash) || ""}`);
const publicAfter = await waitFor("public balance after make-public", async () => {
  const balance = await api("/public-balance");
  return { ok: BigInt(balance.stroops) >= 50_000_000n, value: balance };
});

const sent = await api("/send-public", {
  method: "POST",
  body: { to: recipient.publicKey(), amount: stroopsToDecimal(publicAfter.stroops) },
  idem: `send-public-${run}`,
});
console.log(`[wallet-smoke] send-public tx=${sent.txHash || "none"} ${explorer(sent.txHash) || ""}`);

const finalPrivate = await api("/balance");
const finalPublic = await waitFor("public balance after send-public", async () => {
  const balance = await api("/public-balance");
  return { ok: balance.stroops === "0", value: balance };
});
const recipientFinal = await waitFor("recipient USDC after send-public", async () => {
  const balance = await recipientUsdc(horizon, recipient.publicKey());
  return { ok: Number(balance) >= Number(amount) - 0.000001, value: balance };
});
console.log(`[wallet-smoke] final private=${finalPrivate.stroops} public=${finalPublic.stroops} recipient=${recipientFinal}`);
if (finalPrivate.stroops !== "0") throw new Error(`private balance remained ${finalPrivate.stroops}`);
if (finalPublic.stroops !== "0") throw new Error(`public balance remained ${finalPublic.stroops}`);
if (Number(recipientFinal) < Number(amount) - 0.000001) {
  throw new Error(`recipient did not receive expected USDC: ${recipientFinal}`);
}

const deleted = await api("/account", { method: "DELETE", body: {}, idem: `delete-empty-${run}` });
if (!deleted.deleted) throw new Error(`delete did not return deleted:true: ${JSON.stringify(deleted)}`);
console.log("[wallet-smoke] delete empty succeeded");

const afterSession = await api("/session");
const afterPrivate = await api("/balance");
const afterPublic = await api("/public-balance");
const afterHistory = await api("/history");
const afterContacts = await api("/contacts");
console.log(`[wallet-smoke] after delete handle=${afterSession.handle} private=${afterPrivate.stroops} public=${afterPublic.stroops} history=${afterHistory.length} contacts=${afterContacts.length}`);
assertEmptyFreshState({
  privateBalance: afterPrivate,
  publicBalance: afterPublic,
  history: afterHistory,
  contacts: afterContacts,
});

console.log("[wallet-smoke] PASS account provisioning, exit transfer, and delete/recreate freedom");
