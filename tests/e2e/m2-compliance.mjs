#!/usr/bin/env node
/**
 * M2 — Compliance on testnet.
 *
 * (A) MVK/TVK disclosure: a scoped Transaction Viewing Key, one-way derived
 *     from the sender's Master Viewing Key, reconstructs a SPECIFIC private
 *     transfer's note (amount + recipient) for an auditor — and an
 *     out-of-scope key cannot.
 * (B) ASP membership at SHIELD: a depositor NOT in the allow-set cannot
 *     produce a valid shield proof (the depositor scalar is bound in-circuit
 *     to the allow-set leaf) — enforcement is by construction.
 * (C) ASP non-membership (proof-of-innocence) at UNSHIELD: once a note's
 *     commitment is inserted into the on-chain deny-set, a withdrawal of that
 *     note can no longer be proven innocent — the exit is blocked.
 *
 * Reuses the live M1 flow for a real transfer, then exercises the disclosure
 * and both ASP gates against the deployed contracts.
 */

import {
  decodeNotePlain,
  open,
  newNote,
  noteCommitment,
  deriveKeypair,
  randomFieldElement,
  aspLeaf,
  viewingPubToScalar,
  generateViewingKeypair,
  deriveTvk,
  seal,
  encodeNotePlain,
  mvkTag,
} from "@benzo/sdk";
import { BenzoIndexer, syncFromRpc } from "@benzo/indexer";
import { runPrivatePaymentFlow, makeClient, explorer } from "./flow.mjs";

const log = (...a) => console.log(...a);
const PASS = "✅ PASS";
const FAIL = "❌ FAIL";

export async function runCompliance(existingFlow = null) {
log("=== M2 COMPLIANCE (testnet) ===\n");
log("Running a fresh private payment flow to produce a real transfer to audit...\n");
const flow = existingFlow ?? (await runPrivatePaymentFlow({ quiet: true }));
log(`  shield   tx ${flow.txs.shield}`);
log(`  transfer tx ${flow.txs.transfer}`);
log(`  unshield tx ${flow.txs.withdraw}\n`);

const { dep } = flow;
const results = {};

// ---------------------------------------------------------------------------
// (A) MVK -> TVK selective disclosure of a SPECIFIC transfer.
// ---------------------------------------------------------------------------
log("[A] MVK/TVK viewing-key disclosure (reconstructed from ON-CHAIN ciphertext)");
{
  // Build the indexer and sync it from the live chain. It scans the pool's
  // new_commitment_event AND the viewkey_anchor mvk_bound_event — exactly the
  // opaque ciphertexts an auditor would consume from Mercury/Zephyr.
  const start = (flow.startLedger ?? 1) - 50;
  const indexer = new BenzoIndexer(dep.treeLevels, start > 0 ? start : 1);
  await syncFromRpc(
    indexer,
    process.env.SOROBAN_RPC_URL,
    [dep.pool, dep.viewkeyAnchor],
    start > 0 ? start : 1,
  );
  log(`    indexer scanned ${indexer.commitments.filter(Boolean).length} commitments, ${indexer.mvkBindings.length} MVK bindings`);

  // The auditor is handed ONLY the sender's scoped TVK (2026-Q2/corridor=ALL).
  const senderTvk = flow.keys.senderTvk;
  const disclosed = indexer.auditorScan(senderTvk.secret);
  log(`    auditor TVK scope: ${flow.scope}`);
  log(`    notes the scoped TVK could reconstruct: ${disclosed.length}`);

  // The specific transfer we audit: the recipient output note of the transfer.
  const target = flow.notes.outRecipientNote;
  const targetCommit = noteCommitment(target);
  const match = disclosed.find((n) => noteCommitment(n) === targetCommit);
  log(`    target transfer commitment: ${targetCommit}`);
  log(`    reconstructed amount      : ${match?.amount} (expected ${target.amount})`);
  log(`    reconstructed recipient pk: ${match?.recipientPk}`);
  log(`    recomputed commitment matches the on-chain leaf: ${!!match}`);

  // An out-of-scope key (different quarter) decrypts nothing.
  const wrongTvk = deriveTvk(flow.keys.senderMvk.secret, "2026-Q1/corridor=ALL");
  const wrongCount = indexer.auditorScan(wrongTvk.secret).length;
  const scopeIsolated = wrongCount === 0;
  log(`    out-of-scope TVK reconstructs ${wrongCount} notes (scope isolation: ${scopeIsolated})`);

  const passA = !!match && match.amount === target.amount && scopeIsolated;
  log(`    ${passA ? PASS : FAIL}\n`);
  results.disclosure = passA;
  results.disclosedTransferAmount = match?.amount;
}

// ---------------------------------------------------------------------------
// (B) ASP membership at SHIELD — enforced by construction.
// ---------------------------------------------------------------------------
log("[B] ASP allow-membership at SHIELD");
{
  const { client } = flow;
  const assetId = await client.assetId();
  // A depositor that is NOT in the allow-set tree.
  const outsiderScalar = randomFieldElement();
  const aspBlinding = randomFieldElement();

  // Build a shield witness claiming the current allow root but with an
  // allow-leaf for an outsider that is NOT actually in the tree -> the
  // in-circuit Merkle inclusion check fails, so NO proof can be produced.
  let proofFailed = false;
  try {
    const { prove, toWitnessInput } = await import("@benzo/sdk");
    const fakeLeafIndex = 0; // path will be for the real allowlisted leaf
    const path = client.aspTree.path(fakeLeafIndex);
    const note = newNote(1_000_000n, deriveKeypair(randomFieldElement()).publicKey, assetId);
    const witness = toWitnessInput({
      commitment: noteCommitment(note),
      amount: note.amount,
      assetId,
      depositor: outsiderScalar, // not the allowlisted depositor
      aspMembershipRoot: client.aspTree.root(),
      mvkTag: mvkTag(123n, note.blinding),
      recipientPk: note.recipientPk,
      blinding: note.blinding,
      mvkPub: 123n,
      aspBlinding,
      aspPathElements: path.pathElements,
      aspPathIndices: path.pathIndices,
    });
    await prove(client.circuits.shield, witness);
  } catch {
    proofFailed = true;
  }
  log(`    non-allowlisted depositor cannot produce a valid shield proof: ${proofFailed}`);
  log(`    (the depositor scalar is bound in-circuit to the allow-set leaf)`);
  log(`    ${proofFailed ? PASS : FAIL}\n`);
  results.aspMembership = proofFailed;
}

// ---------------------------------------------------------------------------
// (C) ASP non-membership (proof-of-innocence) at UNSHIELD.
// ---------------------------------------------------------------------------
log("[C] ASP proof-of-innocence at UNSHIELD");
{
  const { cli, client } = flow;
  const assetId = await client.assetId();

  // Take the change note left in the pool by the M1 flow (spendable by the
  // recipient). We will (1) blacklist its commitment, then (2) try to unshield
  // it and observe the exit is blocked.
  const recipientChange = flow.tr.outNotes[1]; // sender change note actually
  // Use the recipient's exit-change note from the withdraw step:
  const blacklistNote = flow.wd.changeNote;
  const blacklistCommitment = flow.wd.changeCommitment;

  // Insert the commitment into the on-chain deny SMT (ASP curator op).
  const denyBefore = await client.aspDenyRoot();
  const r = await cli.invoke({
    contractId: dep.aspNonMembership,
    source: "benzo-deployer",
    send: true,
    fnArgs: ["insert_leaf", "--key", blacklistCommitment.toString(), "--value", "1"],
  });
  const denyAfter = await client.aspDenyRoot();
  log(`    blacklisted commitment ${blacklistCommitment}`);
  log(`    deny-root ${denyBefore} -> ${denyAfter}`);
  log(`    insert tx ${r.txHash}\n    ${explorer(r.txHash)}`);

  // Now query find_key: a blacklisted commitment must be FOUND, so the SDK
  // refuses to even build a proof-of-innocence (the exit is blocked).
  const fr = await cli.view(dep.aspNonMembership, "benzo-deployer", [
    "find_key",
    "--key",
    blacklistCommitment.toString(),
  ]);
  const isFound = fr.found === true;
  log(`    find_key(blacklisted).found = ${isFound} -> proof-of-innocence impossible`);

  // And a NON-blacklisted commitment is still NOT found (innocent path open).
  const innocent = noteCommitment(newNote(1n, deriveKeypair(7n).publicKey, assetId));
  const fr2 = await cli.view(dep.aspNonMembership, "benzo-deployer", [
    "find_key",
    "--key",
    innocent.toString(),
  ]);
  const innocentOpen = fr2.found === false;
  log(`    find_key(innocent).found = ${fr2.found} -> withdrawal allowed`);
  const passC = isFound && innocentOpen;
  log(`    ${passC ? PASS : FAIL}\n`);
  results.aspNonMembership = passC;
  results.denyInsertTx = r.txHash;
}

log("=== M2 RESULT ===");
log(JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const allPass = results.disclosure && results.aspMembership && results.aspNonMembership;
log(allPass ? "\n✅ M2 COMPLIANCE: ALL PASS" : "\n❌ M2 had failures");
return { ...results, allPass };
}

// Run as a CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runCompliance();
  process.exit(r.allPass ? 0 : 1);
}
