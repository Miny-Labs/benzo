/**
 * Benzo end-to-end private-payment flow against Stellar TESTNET.
 *
 * Personas:
 *  - SENDER : benzo-deployer (holds real Circle testnet USDC; ASP-allowlisted)
 *  - RECIPIENT (shielded): a fresh BN254 spend keypair — never appears on-chain
 *  - EXIT account: a DIFFERENT Stellar account with a USDC trustline receiving
 *    the unshielded public USDC
 *
 * Steps: allowlist -> shield -> private transfer (note->note) -> unshield,
 * with on-chain state checks (nullifiers, merkle root/index, balances).
 *
 * Everything here is real: real Groth16 proofs (headless snarkjs in Node),
 * real Circle testnet USDC custody, real Soroban contracts on testnet.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BenzoClient,
  StellarCli,
  configFromEnv,
  aspLeaf,
  deriveKeypair,
  deriveTvk,
  encodeNotePlain,
  generateViewingKeypair,
  newNote,
  randomFieldElement,
  seal,
  viewingPubToScalar,
} from "@benzo/sdk";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const log = (...a) => console.log(...a);
export const explorer = (tx) => `https://stellar.expert/explorer/testnet/tx/${tx}`;

export function loadDeployment() {
  return JSON.parse(readFileSync(`${repo}/deployments/testnet.json`, "utf8"));
}

export function makeClient() {
  const dep = loadDeployment();
  const cli = new StellarCli(configFromEnv());
  const circuits = Object.fromEntries(
    ["shield", "joinsplit", "unshield"].map((c) => [
      c,
      {
        wasmPath: `${repo}/circuits/build/${c}/${c}_js/${c}.wasm`,
        zkeyPath: `${repo}/circuits/build/${c}/${c}.zkey`,
      },
    ]),
  );
  const client = new BenzoClient(
    cli,
    {
      pool: dep.pool,
      verifier: dep.verifier,
      merkle: dep.merkle,
      nullifierSet: dep.nullifierSet,
      aspMembership: dep.aspMembership,
      aspNonMembership: dep.aspNonMembership,
      viewkeyAnchor: dep.viewkeyAnchor,
      token: dep.token,
      treeLevels: dep.treeLevels,
      aspLevels: dep.aspLevels,
      smtLevels: dep.smtLevels,
    },
    circuits,
    "benzo-deployer",
  );
  return { dep, cli, client };
}

export async function usdcBalance(account) {
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${account}`);
  if (!res.ok) return null;
  const body = await res.json();
  const line = body.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === process.env.USDC_ISSUER,
  );
  return line ? line.balance : "0";
}

export async function poolUsdcBalance(cli, dep) {
  const v = await cli.view(dep.token, "benzo-deployer", ["balance", "--id", dep.pool]);
  return BigInt(v);
}

/**
 * Run the full private-payment flow. Returns every artifact needed for the
 * compliance (M2) and corridor (M3) evidence.
 */
export async function runPrivatePaymentFlow({
  shieldAmount = 50_000_000n, // 5 USDC (7dp)
  transferAmount = 30_000_000n, // 3 USDC to the private recipient
  unshieldAmount = 25_000_000n, // 2.5 USDC exits to public
  fee = 0n,
  relayerSource = null, // CLI identity submitting transfer (gasless relay)
  exitAccount = process.env.ANCHOR_DISTRIBUTION_PUBLIC,
  quiet = false,
} = {}) {
  const { dep, cli, client } = makeClient();
  const sender = process.env.DEPLOYER_PUBLIC;
  if (!sender || !exitAccount) throw new Error("load .env first");
  const say = quiet ? () => {} : log;

  say("=== Benzo private payment flow (TESTNET) ===");
  say(`pool   = ${dep.pool}`);
  say(`sender (public depositor) = ${sender}`);
  say(`exit account (different)  = ${exitAccount}`);

  // --- keys ----------------------------------------------------------------
  const senderSpend = deriveKeypair(randomFieldElement());
  const recipientSpend = deriveKeypair(randomFieldElement());
  const senderMvk = generateViewingKeypair();
  const recipientMvk = generateViewingKeypair();
  const recipientView = generateViewingKeypair();
  const scope = "2026-Q2/corridor=ALL";
  const senderTvk = deriveTvk(senderMvk.secret, scope);
  const senderMvkScalar = viewingPubToScalar(senderMvk.publicKey);
  const recipientMvkScalar = viewingPubToScalar(recipientMvk.publicKey);

  const assetId = await client.assetId();

  // --- 0. balances before ---------------------------------------------------
  const beforeSender = await usdcBalance(sender);
  const beforeExit = await usdcBalance(exitAccount);
  const beforePool = await poolUsdcBalance(cli, dep);
  say(`\n[balances before] sender=${beforeSender} exit=${beforeExit} pool=${beforePool}`);

  // --- 0b. Rebuild local mirrors from on-chain events ----------------------
  // Both the pool tree and the ASP allow-tree accrue leaves across runs, so
  // reconstruct them from chain events; paths then fold to the live roots.
  const { fetchAspLeaves, BenzoIndexer: Indexer, syncFromRpc: sync } =
    await import("@benzo/indexer");
  const priorLeaves = await fetchAspLeaves(
    process.env.SOROBAN_RPC_URL,
    dep.aspMembership,
    1,
  );
  client.aspRebuild(priorLeaves);

  const poolIdx = new Indexer(dep.treeLevels, 1);
  await sync(poolIdx, process.env.SOROBAN_RPC_URL, [dep.pool], 1);
  client.poolRebuild(poolIdx.orderedLeaves());
  await client.assertSynced();

  // --- 1. ASP allowlist (curator op at the regulated edge) ------------------

  const aspBlinding = randomFieldElement();
  const depositorScalar = await client.depositorScalar(sender);
  const allowLeaf = aspLeaf(depositorScalar, aspBlinding);
  const r1 = await cli.invoke({
    contractId: dep.aspMembership,
    source: "benzo-deployer",
    send: true,
    fnArgs: ["insert_leaf", "--leaf", allowLeaf.toString()],
  });
  const aspLeafIndex = client.aspMirrorInsert(allowLeaf);
  say(`\n[1] ASP allow-membership: depositor allowlisted`);
  say(`    tx ${r1.txHash}\n    ${explorer(r1.txHash)}`);

  // --- 2. SHIELD -------------------------------------------------------------
  const shieldNote = newNote(shieldAmount, senderSpend.publicKey, assetId);
  const shieldPlain = encodeNotePlain(shieldNote);
  let t = Date.now();
  const sh = await client.shield({
    source: "benzo-deployer",
    from: sender,
    note: shieldNote,
    mvkPubScalar: senderMvkScalar,
    aspBlinding,
    aspLeafIndex,
    noteCt: seal(shieldPlain, senderMvk.publicKey).bytes, // self-note discovery
    mvkCt: seal(shieldPlain, senderTvk.publicKey).bytes, // auditor scope ct
  });
  const shieldMs = Date.now() - t;
  say(`\n[2] SHIELD ${shieldAmount} stroops USDC -> note (proved headlessly in ${shieldMs}ms)`);
  say(`    commitment = ${sh.commitment}`);
  say(`    leaf index = ${sh.leafIndex}`);
  say(`    tx ${sh.txHash}\n    ${explorer(sh.txHash)}`);

  // --- 3. PRIVATE TRANSFER (note -> note join-split) -------------------------
  const senderInput = { note: sh.note, spendSk: senderSpend.spendSk, leafIndex: sh.leafIndex };
  const dummy = client.makeDummyInput(assetId);
  const changeAmount = shieldAmount - transferAmount - fee;

  const outRecipientNote = newNote(transferAmount, recipientSpend.publicKey, assetId);
  const outChangeNote = newNote(changeAmount, senderSpend.publicKey, assetId);
  const outRecipientPlain = encodeNotePlain(outRecipientNote);
  const outChangePlain = encodeNotePlain(outChangeNote);

  // Optional gasless relay: submit the proven transfer via the relayer (it
  // pays the XLM fee and is compensated in USDC out of the shielded pool).
  let relay;
  if (relayerSource) {
    const { BenzoRelayer } = await import("@benzo/relayer");
    const relayer = new BenzoRelayer(cli);
    relay = (a) =>
      relayer.relayTransfer({
        relayerSource,
        relayerAddress: process.env.RELAYER_PUBLIC,
        ...a,
      });
  }

  t = Date.now();
  const tr = await client.transfer({
    source: relayerSource ?? "benzo-deployer",
    relay,
    inputs: [senderInput, dummy],
    // Both transfer outputs are bound to the SENDER's MVK: the sender is the
    // KYC'd disclosing entity for this corridor, so a scoped TVK over the
    // sender's MVK reconstructs the whole transfer for an auditor.
    outputs: [
      { note: outRecipientNote, mvkPubScalar: senderMvkScalar },
      { note: outChangeNote, mvkPubScalar: senderMvkScalar },
    ],
    fee,
    relayer: process.env.RELAYER_PUBLIC,
    noteCts: [
      seal(outRecipientPlain, recipientView.publicKey).bytes, // recipient discovers + spends
      seal(outChangePlain, senderMvk.publicKey).bytes,
    ],
    mvkCts: [
      seal(outRecipientPlain, senderTvk.publicKey).bytes, // auditor (scoped TVK) reconstructs
      seal(outChangePlain, senderTvk.publicKey).bytes,
    ],
  });
  const transferMs = Date.now() - t;
  say(`\n[3] PRIVATE TRANSFER note->note (2-in/2-out join-split, proved in ${transferMs}ms)`);
  say(`    amount + counterparty hidden on-chain; fee=${fee}`);
  say(`    nullifier[0] (sender's note spent) = ${tr.nullifiers[0]}`);
  say(`    out commitment[0] (recipient) = ${tr.outCommitments[0]} @ leaf ${tr.outLeafIndices[0]}`);
  say(`    out commitment[1] (change)    = ${tr.outCommitments[1]} @ leaf ${tr.outLeafIndices[1]}`);
  say(`    tx ${tr.txHash}\n    ${explorer(tr.txHash)}`);

  // --- 4. UNSHIELD to a DIFFERENT account ------------------------------------
  const recipientInput = {
    note: tr.outNotes[0],
    spendSk: recipientSpend.spendSk,
    leafIndex: tr.outLeafIndices[0],
  };
  const exitChangeNote = newNote(
    transferAmount - unshieldAmount,
    recipientSpend.publicKey,
    assetId,
  );
  const exitChangePlain = encodeNotePlain(exitChangeNote);
  const recipientTvk = deriveTvk(recipientMvk.secret, scope);

  t = Date.now();
  const wd = await client.withdraw({
    source: "benzo-deployer", // submitter (pays gas); funds go to exitAccount
    input: recipientInput,
    amount: unshieldAmount,
    to: exitAccount,
    changeNote: exitChangeNote,
    changeMvkPubScalar: recipientMvkScalar,
    changeNoteCt: seal(exitChangePlain, recipientView.publicKey).bytes,
    changeMvkCt: seal(exitChangePlain, recipientTvk.publicKey).bytes,
  });
  const withdrawMs = Date.now() - t;
  say(`\n[4] UNSHIELD ${unshieldAmount} stroops USDC -> ${exitAccount} (proof-of-innocence enforced, proved in ${withdrawMs}ms)`);
  say(`    nullifier (recipient's note spent) = ${wd.nullifier}`);
  say(`    change commitment = ${wd.changeCommitment}`);
  say(`    tx ${wd.txHash}\n    ${explorer(wd.txHash)}`);

  // --- 5. on-chain state evidence --------------------------------------------
  const spent0 = await cli.view(dep.nullifierSet, "benzo-deployer", [
    "is_spent", "--nullifier", tr.nullifiers[0].toString(),
  ]);
  const spentW = await cli.view(dep.nullifierSet, "benzo-deployer", [
    "is_spent", "--nullifier", wd.nullifier.toString(),
  ]);
  const rootNow = await client.onchainPoolRoot();
  const nextIndex = await cli.view(dep.merkle, "benzo-deployer", ["next_index"]);
  const afterSender = await usdcBalance(sender);
  const afterExit = await usdcBalance(exitAccount);
  const afterPool = await poolUsdcBalance(cli, dep);

  say(`\n[5] ON-CHAIN STATE`);
  say(`    nullifier(shield note)    spent on-chain: ${spent0}`);
  say(`    nullifier(recipient note) spent on-chain: ${spentW}`);
  say(`    merkle root (on-chain) = ${rootNow}`);
  say(`    merkle next_index = ${nextIndex} (leaves inserted)`);
  say(`    [balances after] sender=${afterSender} exit=${afterExit} pool=${afterPool}`);

  return {
    dep, cli, client, scope,
    keys: {
      senderSpend, recipientSpend, senderMvk, recipientMvk, recipientView,
      senderTvk, senderMvkScalar, recipientMvkScalar,
    },
    aspBlinding, depositorScalar, allowLeaf,
    sh, tr, wd,
    txs: { allowlist: r1.txHash, shield: sh.txHash, transfer: tr.txHash, withdraw: wd.txHash },
    timings: { shieldMs, transferMs, withdrawMs },
    balances: {
      before: { sender: beforeSender, exit: beforeExit, pool: beforePool },
      after: { sender: afterSender, exit: afterExit, pool: afterPool },
    },
    state: { spent0, spentW, rootNow, nextIndex },
    notes: { outRecipientNote, outChangeNote, exitChangeNote, shieldNote },
    plains: { outRecipientPlain },
    startLedger: r1.ledger,
  };
}
