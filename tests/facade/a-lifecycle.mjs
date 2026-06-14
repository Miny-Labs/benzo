#!/usr/bin/env node
/**
 * ITEM A — SDK FACADE end-to-end.
 *
 * Drives create → shield → send → unshield ENTIRELY through the BenzoClient
 * facade (no low-level pool/indexer/prover wiring in this script). Also covers
 * items B (getBalance + getHistory) and C (async send handle + proving timings).
 */

import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stroopsToUsdc, createOrLoadAccountFile } from "@benzo/core";
import { makeFacade, explorer, usdcBalance } from "./setup.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
mkdirSync(`${repo}/tests/wallets`, { recursive: true });
// fresh "create" each run
rmSync(`${repo}/tests/wallets/alice.json`, { force: true });

const USDC = (n) => BigInt(Math.round(n * 1e7));

// ---- exported facade method signatures (the contract a frontend calls) ----
const API = [
  "createOrLoadAccount(path, {label?, stellarSecret?}) -> {account, created}",
  "createAccount(label?, stellarSecret?) -> BenzoAccount",
  "address() -> BenzoRecipient   // shareable; no spend authority",
  "sync() -> Promise<void>        // rebuild scanner + mirrors from chain",
  "getBalance() -> Promise<bigint>   // aggregated spendable (stroops)",
  "getHistory() -> HistoryItem[]  // {type, amount, counterparty?, timestamp, status, txHash?}",
  "shield({amount, fromAddress, fromSource}) -> {txHash, leafIndex, commitment, note}",
  "send({amount, to, memo?, useRelayer?}) -> SendHandle  // async: pending->proving->settled",
  "unshield({amount, toAddress}) -> {txHash, nullifier}",
  "shareReceipt(scope?) / disclose(scope?) -> {scope, tvk, reconstruct()}",
  "cashIn({amount, fromSource}) -> {fiatInTx, shieldTx, leafIndex}",
  "cashOut({amount}) -> {unshieldTx, fiatOutTx}",
];

console.log("=== ITEM A: BenzoClient facade API ===");
for (const m of API) console.log("  •", m);
console.log("");

// Two facade instances: Alice (sender, holds the funded public edge) + Bob.
const { dep, cli, client: alice } = makeFacade();
const { client: bob } = makeFacade();

const aliceAcct = createOrLoadAccountFile(`${repo}/tests/wallets/alice.json`, {
  label: "alice",
  stellarSecret: process.env.DEPLOYER_SECRET, // Alice's public on/off-ramp edge
}).account;
alice.useAccount(aliceAcct);
const bobAcct = bob.createAccount("bob");
console.log(`[create] alice spendPub=${aliceAcct.spendPub.toString().slice(0, 14)}…  publicEdge=${aliceAcct.stellarAddress.slice(0, 8)}…`);
console.log(`[create] bob   spendPub=${bobAcct.spendPub.toString().slice(0, 14)}…  (no prior state)\n`);

const timings = {}; // end-to-end op wall-clock
const proving = {}; // PURE Groth16 proving wall-clock (item C)

// ---- SHIELD (measure proving wall-clock) ----------------------------------
const aliceBefore = await usdcBalance(aliceAcct.stellarAddress);
let t = Date.now();
const sh = await alice.shield({
  amount: USDC(3),
  fromAddress: aliceAcct.stellarAddress,
  fromSource: "benzo-deployer",
});
timings.shieldMs = Date.now() - t;
proving.shieldMs = sh.provingMs;
console.log(`[shield] 3 USDC -> alice note @leaf ${sh.leafIndex}`);
console.log(`         tx ${sh.txHash}\n         ${explorer(sh.txHash)}`);
await alice.sync();
console.log(`[balance] alice spendable = ${stroopsToUsdc(await alice.getBalance())} USDC`);
console.log(`          alice public USDC ${aliceBefore} -> ${await usdcBalance(aliceAcct.stellarAddress)}\n`);

// ---- SEND (async handle: pending -> proving -> settled) -------------------
console.log("[send] Alice -> Bob, 1.8 USDC (async handle):");
t = Date.now();
const handle = alice
  .send({ amount: USDC(1.8), to: bob.address(), memo: "lunch" })
  .onProgress((e) => console.log(`        · ${e.status}${e.detail ? " — " + e.detail : ""}${e.txHash ? " tx " + e.txHash : ""}`));
console.log(`        handle id=${handle.id} returned immediately (status=${handle.status})`);
const sendResult = await handle.settled();
timings.transferMs = Date.now() - t;
proving.transferMs = sendResult.provingMs;
console.log(`        settled: tx ${sendResult.txHash}\n        ${explorer(sendResult.txHash)}\n`);

// ---- Bob sees the funds (getBalance + getHistory) -------------------------
await bob.sync();
const bobBal = await bob.getBalance();
console.log(`[balance] bob spendable = ${stroopsToUsdc(bobBal)} USDC (received privately)`);
console.log("[history] bob:");
for (const h of bob.getHistory()) {
  console.log(`        ${new Date(h.timestamp * 1000).toISOString()}  ${h.type.padEnd(8)} ${stroopsToUsdc(BigInt(h.amount))} USDC  from ${h.counterparty}  [${h.status}]`);
}
console.log("[history] alice:");
for (const h of alice.getHistory()) {
  console.log(`        ${new Date(h.timestamp * 1000).toISOString()}  ${h.type.padEnd(8)} ${stroopsToUsdc(BigInt(h.amount))} USDC  -> ${h.counterparty}  [${h.status}]`);
}
console.log("");

// ---- UNSHIELD (Bob cashes out to a DIFFERENT public account) --------------
const exit = process.env.ANCHOR_DISTRIBUTION_PUBLIC;
const exitBefore = await usdcBalance(exit);
t = Date.now();
const wd = await bob.unshield({ amount: USDC(1.5), toAddress: exit });
timings.unshieldMs = Date.now() - t;
proving.unshieldMs = wd.provingMs;
console.log(`[unshield] bob -> ${exit.slice(0, 8)}… 1.5 USDC`);
console.log(`           tx ${wd.txHash}\n           ${explorer(wd.txHash)}`);
console.log(`           exit USDC ${exitBefore} -> ${await usdcBalance(exit)}\n`);

// ---- proving timings (item C measurement) ---------------------------------
console.log("=== ITEM C: measured wall-clock (headless Groth16, Node) ===");
console.log(`   PURE PROVING   shield ${proving.shieldMs}ms · transfer ${proving.transferMs}ms · unshield ${proving.unshieldMs}ms`);
console.log(`   full op (incl. chain sync + submit + confirm):`);
console.log(`                  shield ${timings.shieldMs}ms · transfer ${timings.transferMs}ms · unshield ${timings.unshieldMs}ms`);

console.log("\n=== A/B/C SUMMARY ===");
console.log(
  JSON.stringify(
    {
      txs: { shield: sh.txHash, send: sendResult.txHash, unshield: wd.txHash },
      bobBalanceUsdc: stroopsToUsdc(bobBal),
      provingMs: proving,
      fullOpMs: timings,
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
process.exit(0);
