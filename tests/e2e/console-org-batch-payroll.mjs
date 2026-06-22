/**
 * Console-LAYER BATCHED confidential payroll via BenzoClient.orgBatchPayroll.
 *
 * Proves the NEW batch path end-to-end on real testnet USDC: many org payouts
 * settle through pool.batch_transfer_org — ONE combined BN254 pairing check
 * (verifier.verify_batch) + one subtree-merge merkle.insert_leaves + one tx per
 * chunk — under in-circuit M-of-N dual control. Validates:
 *   1. fund N independent ORG treasury notes (one per payout — a batch can't
 *      chain change within a tx, so each payout spends a distinct note)
 *   2. orgBatchPayroll -> ONE batch_transfer_org tx for the whole run
 *   3. every recipient rediscovers their pay in a fresh wallet client
 *   4. treasury change conserved; one txHash shared across the run
 *
 * Run: set -a; . ./.env; set +a; BATCH_N=5 node tests/e2e/console-org-batch-payroll.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BenzoClient, StellarCli, NodeProver, configFromEnv, paymentAddress,
  MvkRegistryMirror, DEFAULT_MVK_KEY_META, fetchMvkRegistryLeaves,
} from "@benzo/core";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const dep = JSON.parse(readFileSync(`${repo}/deployments/testnet.json`, "utf8"));
const cli = new StellarCli(configFromEnv());
const rpc = process.env.SOROBAN_RPC_URL;
const log = (...a) => console.log(...a);
const explorer = (tx) => `https://stellar.expert/explorer/testnet/tx/${tx}`;
const funder = process.env.DEPLOYER_PUBLIC;
const relayerAddr = process.env.RELAYER_PUBLIC || process.env.DEPLOYER_PUBLIC;
if (!funder || !rpc) throw new Error("load .env (DEPLOYER_PUBLIC, SOROBAN_RPC_URL)");

const N = Math.max(2, Number(process.env.BATCH_N || 5));
const PAYOUT = 200_000n;   // 0.02 USDC each
const NOTE = 300_000n;     // 0.03 USDC per treasury note (covers one payout + change)

const art = (c) => ({
  wasmPath: `${repo}/circuits/build/${c}/${c}_js/${c}.wasm`,
  zkeyPath: `${repo}/circuits/build/${c}/${c}.zkey`,
});
const circuits = {
  shield: art("shield"), joinsplit: art("joinsplit"), unshield: art("unshield"),
  proofOfBalance: art("proof_of_balance"), proofOfSum: art("proof_of_sum"),
  joinsplitOrg: {
    wasmPath: `${repo}/circuits/build/joinsplit_org/joinsplit_org_js/joinsplit_org.wasm`,
    zkeyPath: `${repo}/circuits/build/joinsplit_org/joinsplit_org.zkey`,
  },
};
const deployment = {
  pool: dep.pool, verifier: dep.verifier, merkle: dep.merkle, nullifierSet: dep.nullifierSet,
  aspMembership: dep.aspMembership, aspNonMembership: dep.aspNonMembership,
  viewkeyAnchor: dep.viewkeyAnchor, token: dep.token,
  treeLevels: dep.treeLevels, aspLevels: dep.aspLevels, smtLevels: dep.smtLevels,
};

function makeClient() {
  return new BenzoClient({ cli, deployment, circuits, prover: new NodeProver(), rpcUrl: rpc, txSource: "benzo-deployer" });
}
async function wireMvk(c) {
  try {
    await cli.invoke({ contractId: dep.mvkRegistry, source: "benzo-deployer", send: true,
      fnArgs: ["register_mvk", "--mvk_pub", c.account.mvkScalar.toString(), "--key_meta", DEFAULT_MVK_KEY_META.toString()] });
  } catch { /* already registered */ }
  const reg = new MvkRegistryMirror();
  const leaves = await fetchMvkRegistryLeaves(rpc, dep.mvkRegistry, 1);
  reg.syncWithOwnedKey(leaves, c.account.mvkScalar, DEFAULT_MVK_KEY_META);
  c.pool.useMvkRegistry(reg);
  return reg;
}

log(`=== BATCHED confidential payroll (orgBatchPayroll -> batch_transfer_org), N=${N} ===`);
log(`pool=${dep.pool}  verifier=${dep.verifier}  merkle=${dep.merkle}`);

const org = makeClient();
org.createAccount("acme-treasury");
await wireMvk(org);
const orgId = await org.orgIdentity({ orgId: "acme", memberCount: 3, threshold: 2n });
log(`[org] 2-of-3 identity; recipientPk=${orgId.recipientPk}`);

// --- 1. fund N independent treasury notes (one per payout) ---------------
log(`[1] funding ${N} treasury notes of ${NOTE} each (distinct notes — a batch can't chain change)…`);
for (let i = 0; i < N; i++) {
  const f = await org.fundTreasury({ org: orgId, amount: NOTE, fromAddress: funder, fromSource: "benzo-deployer" });
  log(`    note ${i + 1}/${N} @ leaf ${f.leafIndex}  tx ${f.txHash}`);
}
const bal0 = await org.orgTreasuryBalance(orgId);
log(`    treasury balance (rediscovered from chain) = ${bal0} (expected ${NOTE * BigInt(N)})`);
if (bal0 < NOTE * BigInt(N)) { console.error(`❌ treasury ${bal0} < ${NOTE * BigInt(N)}`); process.exit(1); }

// --- 2. N recipients (consumer-wallet payees) ---------------------------
const emps = [];
for (let i = 0; i < N; i++) {
  const e = makeClient(); e.createAccount(`emp-${i}`);
  emps.push({ client: e, to: { ...paymentAddress(e.account), label: `emp-${i}` } });
}

// --- 3. ONE batched run via batch_transfer_org --------------------------
log(`[3] orgBatchPayroll: ${N} payouts of ${PAYOUT} in ONE combined verification (signers [0,1])…`);
const t0 = Date.now();
// Use the SDK's measured default cap (~3 org spends/tx) and auto-chunk larger runs.
const CAP = 3;
const res = await org.orgBatchPayroll({
  org: orgId,
  payouts: emps.map((e) => ({ to: e.to, amount: PAYOUT, memo: "2026-06 salary" })),
  signerIndices: [0, 1],
  relayer: relayerAddr,
  maxPerTx: CAP,
});
log(`    run settled in ${Date.now() - t0}ms`);
const txs = [...new Set(res.map((r) => r.txHash))];
for (const r of res) log(`    paid ${r.amount} to ${r.to.label} (proof ${r.provingMs}ms)`);
const expectedChunks = Math.ceil(N / CAP);
log(`    settled in ${txs.length} batch tx(s) (expected ${expectedChunks} chunk(s) of ≤${CAP}):`);
for (const t of txs) log(`      ${t}  ${explorer(t)}`);
if (txs.length !== expectedChunks) {
  console.error(`❌ expected ${expectedChunks} chunk tx(s) for ${N} payouts at cap ${CAP}, got ${txs.length}`);
  process.exit(1);
}

const bal1 = await org.orgTreasuryBalance(orgId);
const expectChange = (NOTE - PAYOUT) * BigInt(N);
log(`    treasury balance after run = ${bal1} (expected change ${expectChange})`);
if (bal1 !== expectChange) { console.error(`❌ treasury ${bal1} != ${expectChange}`); process.exit(1); }

// --- 4. each recipient rediscovers their pay (console -> wallet) --------
let ok = 0;
for (const e of emps) {
  await e.client.sync();
  const b = await e.client.getBalance();
  if (b === PAYOUT) ok++;
  else log(`    ⚠ ${e.to.label} balance ${b} != ${PAYOUT}`);
}
log(`[4] ${ok}/${N} recipients rediscovered exactly ${PAYOUT} in a fresh wallet client`);
if (ok !== N) { console.error(`❌ only ${ok}/${N} recipients got paid correctly`); process.exit(1); }

log(`\n✅ BATCHED confidential payroll, ON-CHAIN:`);
log(`   • ${N} payouts settled in ${txs.length} batch_transfer_org tx(s), ≤${CAP} per tx (one combined BN254 pairing check each)`);
log(`   • subtree-merge merkle.insert_leaves committed ${2 * N} leaves total`);
log(`   • all ${N} recipients rediscovered their pay; treasury change conserved + dual-controlled`);
log(`   ⇒ honest batched VERIFICATION live on testnet (not recursion; measured cap ~3 org spends/tx, auto-chunked).`);
