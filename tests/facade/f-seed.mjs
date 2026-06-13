#!/usr/bin/env node
/**
 * ITEM F — seed the anonymity set with ≥100 notes.
 *
 * Shields many tiny notes into the pool to grow the Merkle tree past 100
 * leaves, then reads the LIVE on-chain merkle next_index to confirm.
 *
 * Efficient: syncs mirrors ONCE, allowlists the depositor ONCE, then loops
 * prove→submit. Shield proofs don't depend on the pool root, so no per-shield
 * re-sync is needed.
 */

import {
  aspLeaf,
  encodeNotePlain,
  generateViewingKeypair,
  mvkTag,
  newNote,
  noteCommitment,
  prove,
  randomFieldElement,
  seal,
  toWitnessInput,
} from "@benzo/sdk";
import { makeFacade, circuitSet, liveNextIndex } from "./setup.mjs";

const TARGET = 105; // comfortably ≥ 100
const AMOUNT = 1000n; // 0.0001 USDC per note

const { dep, cli, client } = makeFacade();
client.createAccount("seeder", process.env.DEPLOYER_SECRET);

const startIndex = await liveNextIndex(cli, dep);
console.log(`=== ITEM F: seed anonymity set ===`);
console.log(`live next_index at start: ${startIndex}`);
const toAdd = Math.max(0, TARGET - startIndex);
console.log(`shielding ${toAdd} notes to reach >= ${TARGET}...\n`);

await client.sync();

// Allowlist the depositor ONCE; reuse for every shield.
const aspBlinding = randomFieldElement();
const depositorScalar = await client.pool.depositorScalar(process.env.DEPLOYER_PUBLIC);
const leaf = aspLeaf(depositorScalar, aspBlinding);
await cli.invoke({
  contractId: dep.aspMembership,
  source: "benzo-deployer",
  send: true,
  fnArgs: ["insert_leaf", "--leaf", leaf.toString()],
});
const aspLeafIndex = client.pool.aspMirrorInsert(leaf);
const allowRoot = client.pool.aspTree.root();
const aspPath = client.pool.aspTree.path(aspLeafIndex);

const assetId = await client.pool.assetId();
const mvkScalar = client.account.mvkScalar;
const view = generateViewingKeypair();
const shield = circuitSet().shield;

const t0 = Date.now();
for (let i = 0; i < toAdd; i++) {
  const note = newNote(AMOUNT, client.account.spendPub, assetId);
  const commitment = noteCommitment(note);
  const tag = mvkTag(mvkScalar, note.blinding);
  const plain = encodeNotePlain({ ...note });
  const witness = toWitnessInput({
    commitment,
    amount: AMOUNT,
    assetId,
    depositor: depositorScalar,
    aspMembershipRoot: allowRoot,
    mvkTag: tag,
    recipientPk: note.recipientPk,
    blinding: note.blinding,
    mvkPub: mvkScalar,
    aspBlinding,
    aspPathElements: aspPath.pathElements,
    aspPathIndices: aspPath.pathIndices,
  });
  const proof = await prove(shield, witness);
  await cli.invoke({
    contractId: dep.pool,
    source: "benzo-deployer",
    send: true,
    fnArgs: [
      "shield",
      "--from", process.env.DEPLOYER_PUBLIC,
      "--amount", AMOUNT.toString(),
      "--commitment", commitment.toString(),
      "--mvk_tag", tag.toString(),
      "--note_ct", Buffer.from(seal(plain, view.publicKey).bytes).toString("hex"),
      "--mvk_ct", Buffer.from(seal(plain, view.publicKey).bytes).toString("hex"),
      "--asp_membership_root", allowRoot.toString(),
      "--proof", JSON.stringify(proof.sorobanProof),
    ],
  });
  if ((i + 1) % 10 === 0 || i + 1 === toAdd) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  shielded ${i + 1}/${toAdd}  (~${elapsed}s elapsed)`);
  }
}

// Confirm against the LIVE on-chain tree.
const finalIndex = await liveNextIndex(cli, dep);
console.log(`\n=== F RESULT ===`);
console.log(`live on-chain merkle next_index = ${finalIndex}  (>= 100: ${finalIndex >= 100})`);
console.log(
  JSON.stringify({ startIndex, shielded: toAdd, finalNextIndex: finalIndex, atLeast100: finalIndex >= 100 }, null, 2),
);
process.exit(finalIndex >= 100 ? 0 : 1);
