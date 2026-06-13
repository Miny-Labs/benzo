#!/usr/bin/env node
/**
 * ITEM E — claim-links.
 *
 * Alice creates a claim link (encrypts a note to a random claim secret). A
 * FRESH account with NO prior state parses the link, derives the claim account,
 * and claims the funds to its own brand-new public address. Shows the link, the
 * claim tx, and before/after balances.
 */

import { BenzoClient } from "@benzo/sdk";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { makeFacade, explorer, usdcBalance } from "./setup.mjs";

const USDC = (n) => BigInt(Math.round(n * 1e7));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;

/** Create + fund a brand-new public account with a USDC trustline. */
async function freshAccount() {
  const horizon = new Horizon.Server(process.env.HORIZON_URL);
  const kp = Keypair.random();
  await fetch(`${process.env.FRIENDBOT_URL}?addr=${kp.publicKey()}`);
  await sleep(1500);
  const acct = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset(process.env.USDC_CODE, process.env.USDC_ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  return kp;
}

console.log("=== ITEM E: claim-links ===\n");

// Alice funds herself and mints a claim link.
const { client: alice } = makeFacade();
alice.createAccount("alice", process.env.DEPLOYER_SECRET);
console.log("[setup] Alice shields 2 USDC");
const sh = await alice.shield({
  amount: USDC(2),
  fromAddress: alice.account.stellarAddress,
  fromSource: "benzo-deployer",
});
console.log(`        shield tx ${sh.txHash}`);

console.log("\n[create] Alice mints a claim link for 1.0 USDC");
const { link, sendTx } = await alice.createClaimLink({ amount: USDC(1.0) });
console.log(`        send-to-link tx ${sendTx}\n        ${explorer(sendTx)}`);
console.log(`        CLAIM LINK: ${link}`);

// A FRESH claimant with no prior Benzo or on-chain state.
console.log("\n[claim] a FRESH account (no prior state) claims the link");
const claimantKp = await freshAccount();
const claimantAddr = claimantKp.publicKey();
const before = await usdcBalance(claimantAddr);
console.log(`        claimant ${claimantAddr.slice(0, 8)}…  USDC before = ${before}`);

const { client: claimant } = makeFacade();
const secret = BenzoClient.parseClaimLink(link);
const claimed = await claimant.claim({ claimSecret: secret, toAddress: claimantAddr });
const after = await usdcBalance(claimantAddr);
console.log(`        claim tx ${claimed.txHash}\n        ${explorer(claimed.txHash)}`);
console.log(`        claimant USDC after  = ${after}`);

// Double-claim must now fail (note already spent).
let doubleClaimRejected = false;
try {
  const { client: c2 } = makeFacade();
  await c2.claim({ claimSecret: secret, toAddress: claimantAddr });
} catch {
  doubleClaimRejected = true;
}

console.log("\n=== E SUMMARY ===");
console.log(
  JSON.stringify(
    {
      link,
      sendToLinkTx: sendTx,
      claimTx: claimed.txHash,
      claimedUsdc: (Number(claimed.amount) / 1e7).toFixed(7),
      claimantBefore: before,
      claimantAfter: after,
      doubleClaimRejected,
    },
    null,
    2,
  ),
);
process.exit(Number(after) > Number(before) ? 0 : 1);
