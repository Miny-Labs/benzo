#!/usr/bin/env node
/**
 * M3 — Self-hosted SEP-24 corridor, end-to-end on testnet.
 *
 *   fiat-sim IN  -> SHIELD -> PRIVATE TRANSFER -> UNSHIELD -> fiat-sim OUT
 *
 * Hops:
 *  1. SEP-10 auth + SEP-24 deposit: the self-hosted anchor settles REAL
 *     testnet USDC to the sender (fiat leg SIMULATED, labeled).
 *  2. SHIELD the settled USDC into the Benzo pool (real Groth16 proof).
 *  3. PRIVATE TRANSFER note->note (amount + counterparty hidden).
 *  4. UNSHIELD to the recipient's public account (proof-of-innocence).
 *  5. SEP-24 withdraw: the recipient sends the USDC to the anchor (REAL
 *     on-chain) and the anchor SIMULATES the local fiat payout.
 *
 * Everything on-chain is real testnet USDC + real proofs. Only the bank/cash
 * fiat ledger is simulated — by our own self-hosted anchor, disclosed here
 * and in the README.
 */

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { AnchorClient, anchorConfigFromEnv } from "@benzo/anchor";
import {
  aspLeaf,
  deriveKeypair,
  newNote,
  randomFieldElement,
  generateViewingKeypair,
  deriveTvk,
  viewingPubToScalar,
  seal,
  encodeNotePlain,
  MvkRegistryMirror,
  fetchMvkRegistryLeaves,
} from "@benzo/core";
import { BenzoIndexer, syncFromRpc, fetchAspLeaves } from "@benzo/indexer";
import { makeClient, usdcBalance, explorer } from "./flow.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HORIZON = process.env.HORIZON_URL;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const USDC = new Asset(process.env.USDC_CODE, process.env.USDC_ISSUER);

async function startAnchor() {
  const child = spawn("node", [`${repo}/packages/anchor/dist/server.js`], {
    env: { ...process.env, ANCHOR_PORT: "8888" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`  [anchor] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`  [anchor:err] ${d}`));
  // wait for the toml to come up
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://localhost:8888/.well-known/stellar.toml");
      if (r.ok) return child;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error("anchor failed to start");
}

/** Create + fund a fresh recipient cash-out account with a USDC trustline. */
async function makeRecipientAccount() {
  const horizon = new Horizon.Server(HORIZON);
  const kp = Keypair.random();
  const fb = await fetch(`${process.env.FRIENDBOT_URL}?addr=${kp.publicKey()}`);
  if (!fb.ok) throw new Error("friendbot funding failed");
  await sleep(1500);
  const acct = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  return kp;
}

export async function runCorridor() {
  const anchor = await startAnchor();
  const out = { real: {}, simulated: {}, txs: {} };
  try {
    const ac = new AnchorClient(anchorConfigFromEnv());
    const toml = await ac.toml();
    log("=== M3 CORRIDOR (testnet) ===\n");
    log("[SEP-1] anchor stellar.toml discovered:");
    log(`    WEB_AUTH_ENDPOINT       = ${toml.WEB_AUTH_ENDPOINT}`);
    log(`    TRANSFER_SERVER_SEP0024 = ${toml.TRANSFER_SERVER_SEP0024}`);
    log(`    SIGNING_KEY             = ${toml.SIGNING_KEY}`);
    log(`    currency ${process.env.USDC_CODE} issuer pinned = ${process.env.USDC_ISSUER}\n`);

    const sender = process.env.DEPLOYER_PUBLIC;
    const depositAmount = "4.0000000"; // 4 USDC of "fiat"
    const depositStroops = 40_000_000n;

    // --- 1. fiat-sim IN: SEP-10 + SEP-24 deposit --------------------------
    log("[1] FIAT-IN  (fiat leg SIMULATED) -> anchor settles real USDC");
    const jwt = await ac.authenticate(process.env.DEPLOYER_SECRET);
    log(`    SEP-10 JWT obtained for ${sender.slice(0, 8)}…`);
    const senderBefore = await usdcBalance(sender);
    const dep = await ac.startDeposit(jwt, sender, depositAmount);
    log(`    SEP-24 deposit id=${dep.id.slice(0, 8)}…  interactive url=${dep.url}`);
    const depTx = await ac.sim(jwt, dep.id, { amount: depositAmount });
    log(`    [SIMULATED] ${depTx.message}`);
    log(`    anchor->sender USDC settlement tx ${depTx.stellar_transaction_id}`);
    log(`    ${explorer(depTx.stellar_transaction_id)}`);
    const senderAfterDeposit = await usdcBalance(sender);
    log(`    sender USDC ${senderBefore} -> ${senderAfterDeposit}\n`);
    out.real.depositSettlementTx = depTx.stellar_transaction_id;
    out.txs.fiatInSettlement = depTx.stellar_transaction_id;

    // --- 2-4. SHIELD -> PRIVATE TRANSFER -> UNSHIELD ----------------------
    const { dep: deployment, cli, client } = makeClient();

    // rebuild mirrors from chain
    const priorLeaves = await fetchAspLeaves(process.env.SOROBAN_RPC_URL, deployment.aspMembership, 1);
    client.aspRebuild(priorLeaves);
    const poolIdx = new BenzoIndexer(deployment.treeLevels, 1);
    await syncFromRpc(poolIdx, process.env.SOROBAN_RPC_URL, [deployment.pool], 1);
    client.poolRebuild(poolIdx.orderedLeaves());

    const assetId = await client.assetId();
    const senderSpend = deriveKeypair(randomFieldElement());
    const recipientSpend = deriveKeypair(randomFieldElement());
    const senderMvk = generateViewingKeypair();
    const recipientView = generateViewingKeypair();
    const scope = "2026-Q2/corridor=US-MX";
    const senderTvk = deriveTvk(senderMvk.secret, scope);
    const senderMvkScalar = viewingPubToScalar(senderMvk.publicKey);

    // Authorized-MVK registry (P0 enforcement): resume the registry, register
    // this corridor's MVK on-chain + in a synced mirror, and drive the client
    // from it so registeredMvkRoot is a root the pool's check_mvk_root knows.
    if (deployment.mvkRegistry) {
      const mvkReg = new MvkRegistryMirror();
      mvkReg.syncLeaves(
        await fetchMvkRegistryLeaves(process.env.SOROBAN_RPC_URL, deployment.mvkRegistry, 1),
      );
      await cli.invoke({
        contractId: deployment.mvkRegistry,
        source: "benzo-deployer",
        send: true,
        fnArgs: ["register_mvk", "--mvk_pub", senderMvkScalar.toString(), "--key_meta", "0"],
      });
      mvkReg.register(senderMvkScalar, 0n);
      const onchainMvkRoot = BigInt(
        await cli.view(deployment.mvkRegistry, "benzo-deployer", ["current_root"]),
      );
      if (mvkReg.root() !== onchainMvkRoot) {
        throw new Error(
          `mvk_registry mirror drift (corridor): mirror=${mvkReg.root()} onchain=${onchainMvkRoot}`,
        );
      }
      client.useMvkRegistry(mvkReg);
    }

    // ASP allowlist the sender at the regulated edge
    const aspBlinding = randomFieldElement();
    const depositorScalar = await client.depositorScalar(sender);
    const allowLeaf = aspLeaf(depositorScalar, aspBlinding);
    const allowTx = await cli.invoke({
      contractId: deployment.aspMembership,
      source: "benzo-deployer",
      send: true,
      fnArgs: ["insert_leaf", "--leaf", allowLeaf.toString()],
    });
    const aspLeafIndex = client.aspMirrorInsert(allowLeaf);
    log(`[2] SHIELD ${depositStroops} stroops USDC into the pool`);
    const shieldNote = newNote(depositStroops, senderSpend.publicKey, assetId);
    const shieldPlain = encodeNotePlain(shieldNote);
    const sh = await client.shield({
      source: "benzo-deployer",
      from: sender,
      note: shieldNote,
      mvkPubScalar: senderMvkScalar,
      aspBlinding,
      aspLeafIndex,
      noteCt: seal(shieldPlain, senderMvk.publicKey).bytes,
      mvkCt: seal(shieldPlain, senderTvk.publicKey).bytes,
    });
    log(`    shield tx ${sh.txHash}\n    ${explorer(sh.txHash)}\n`);
    out.txs.shield = sh.txHash;

    log("[3] PRIVATE TRANSFER note->note (amount + counterparty hidden)");
    const transferStroops = depositStroops; // forward the whole note
    const recipientNote = newNote(transferStroops, recipientSpend.publicKey, assetId);
    const dummy = client.makeDummyInput(assetId);
    const recipientPlain = encodeNotePlain(recipientNote);
    const changeNote = newNote(0n, senderSpend.publicKey, assetId);
    const changePlain = encodeNotePlain(changeNote);
    const tr = await client.transfer({
      source: "benzo-deployer",
      inputs: [{ note: sh.note, spendSk: senderSpend.spendSk, leafIndex: sh.leafIndex }, dummy],
      outputs: [
        { note: recipientNote, mvkPubScalar: senderMvkScalar },
        { note: changeNote, mvkPubScalar: senderMvkScalar },
      ],
      fee: 0n,
      relayer: process.env.RELAYER_PUBLIC,
      noteCts: [seal(recipientPlain, recipientView.publicKey).bytes, seal(changePlain, senderMvk.publicKey).bytes],
      mvkCts: [seal(recipientPlain, senderTvk.publicKey).bytes, seal(changePlain, senderTvk.publicKey).bytes],
    });
    log(`    transfer tx ${tr.txHash}\n    ${explorer(tr.txHash)}\n`);
    out.txs.transfer = tr.txHash;

    // recipient cash-out account
    log("[4] UNSHIELD -> recipient public account (proof-of-innocence enforced)");
    const recipientKp = await makeRecipientAccount();
    log(`    fresh recipient cash-out account ${recipientKp.publicKey()} (USDC trustline opened)`);
    const wd = await client.withdraw({
      source: "benzo-deployer",
      input: { note: tr.outNotes[0], spendSk: recipientSpend.spendSk, leafIndex: tr.outLeafIndices[0] },
      amount: transferStroops,
      to: recipientKp.publicKey(),
      changeNote: newNote(0n, recipientSpend.publicKey, assetId),
      changeMvkPubScalar: senderMvkScalar,
      changeNoteCt: seal(encodeNotePlain(newNote(0n, recipientSpend.publicKey, assetId)), recipientView.publicKey).bytes,
      changeMvkCt: seal(encodeNotePlain(newNote(0n, recipientSpend.publicKey, assetId)), senderTvk.publicKey).bytes,
    });
    const recipientUsdc = await usdcBalance(recipientKp.publicKey());
    log(`    unshield tx ${wd.txHash}\n    ${explorer(wd.txHash)}`);
    log(`    recipient USDC balance = ${recipientUsdc}\n`);
    out.txs.unshield = wd.txHash;

    // --- 5. fiat-sim OUT: SEP-24 withdraw ---------------------------------
    log("[5] FIAT-OUT (fiat leg SIMULATED) <- recipient sends USDC to anchor");
    const rjwt = await ac.authenticate(recipientKp.secret());
    const wtx = await ac.startWithdraw(rjwt, recipientKp.publicKey(), depositAmount);
    log(`    SEP-24 withdraw id=${wtx.id.slice(0, 8)}…`);
    log(`    anchor withdraw account=${wtx.withdraw_anchor_account} memo=${wtx.withdraw_memo}`);
    const payHash = await ac.sendUsdcToAnchor(
      recipientKp.secret(),
      wtx.withdraw_anchor_account,
      depositAmount,
      wtx.withdraw_memo,
    );
    log(`    recipient->anchor USDC tx ${payHash}`);
    log(`    ${explorer(payHash)}`);
    const done = await ac.sim(rjwt, wtx.id, { stellar_transaction_id: payHash, amount: depositAmount });
    log(`    [SIMULATED] ${done.message}`);
    log(`    SEP-24 withdraw status=${done.status}\n`);
    out.txs.fiatOutReceipt = payHash;
    out.real.withdrawReceiptTx = payHash;
    out.simulated.fiatIn = "anchor credited 'fiat received' with no real bank";
    out.simulated.fiatOut = "anchor 'fiat payout' with no real bank";

    log("=== M3 CORRIDOR COMPLETE ===");
    log("REAL on testnet : SEP-10 JWT, SEP-24 lifecycle, USDC settlement both edges, shield/transfer/unshield proofs");
    log("SIMULATED       : the fiat (bank/cash) leg, by our self-hosted anchor");
    log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return out;
  } finally {
    anchor.kill();
  }
}

// Run as a CLI when invoked directly (pathToFileURL handles spaces in the path).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCorridor()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
