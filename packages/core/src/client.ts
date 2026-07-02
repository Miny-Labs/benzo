/**
 * BenzoClient — the single, UI-facing SDK facade.
 *
 * A frontend (or any caller) uses ONLY this class: it hides the pool client,
 * the note scanner/indexer, the headless prover, and the viewing-key crypto
 * behind stable, typed methods:
 *
 *   createOrLoadAccount · getBalance · getHistory · shield · send · unshield
 *   shareReceipt/disclose · cashIn · cashOut
 *
 * `send()` is non-blocking: it returns a SendHandle that reports
 * pending → proving → settled and resolves on settlement, so a UI can render
 * optimistic state over the proving pipeline.
 */

import { toHex, fromHex, toBase64Url, fromBase64Url } from "./crypto/bytes.js";
import {
  BenzoPoolClient,
  type BenzoDeployment,
  type CircuitSet,
  type SpendableNote,
} from "./pool.js";
import {
  NoteScanner,
  syncFromRpc,
  fetchAspLeaves,
  fetchAspLeavesSince,
  fetchPoolStorageFrontier,
  fetchLatestAspWitnessFromStorage,
  fetchLatestPoolWitnessFromStorage,
  fetchPoolWitnessFromStorageWithKnownSuffix,
  appendPoolWitnessesFromFrontier,
  type ScannerSnapshot,
  type AspSnapshot,
  type AspMembershipWitness,
} from "./scanner.js";
import type { KVStore } from "./store.js";
import {
  type Note,
  aspLeaf,
  deriveKeypair,
  mvkTag,
  newNote,
  noteCommitment,
  noteNullifier,
  randomFieldElement,
} from "./notes.js";
import {
  type ViewingKeypair,
  decodeNotePlain,
  deriveTvk,
  encodeNotePlain,
  open,
  seal,
  viewingPubToScalar,
} from "./viewkeys.js";
import {
  type BenzoAccount,
  accountFromClaimSecret,
  createAccount,
} from "./account.js";
import type { ChainClient } from "./stellar.js";
import { feHex } from "./crypto/groth16.js";
import { proveBalance as generateBalanceProof, proveBalanceOrg as generateBalanceProofOrg, selectNotesForBalance } from "./balance.js";
import { proveSum as generateSumProof, proveSumOrg as generateSumProofOrg, MAX_SUM_NOTES } from "./sum.js";
import { proveSpendingCap as generateSpendingCapProof } from "./spendingcap.js";
import { provePayoutInnocence as generatePayoutInnocenceProof } from "./payoutinnocence.js";
import { proveOrgApproval as generateOrgApprovalProof } from "./orgauth.js";
import { provePayrollComputation as generatePayrollComputationProof, type PayrollLineInput } from "./payrollcomp.js";
import { proveKybCredential as generateKybCredentialProof } from "./kybcredential.js";
import { proveCrossNetting as generateCrossNettingProof } from "./netting.js";
import { transferRelayFnArgs } from "./relay.js";
import {
  type OrgIdentity,
  type OrgSignature,
  deriveOrgIdentity,
} from "./org.js";
import type { ProveResult, ProverPort } from "./prover.js";
import { encodeBenzoLink, parseBenzoLink } from "@benzo/links";
import { randomBytes } from "./crypto/random.js";
import { rpc } from "@stellar/stellar-sdk";

/** A recipient's public, shareable address (no spend authority). */
export interface BenzoRecipient {
  spendPub: bigint;
  viewPub: Uint8Array;
  /** scalar of the recipient's MVK; defaults to the sender's MVK if omitted */
  mvkScalar?: bigint;
  label?: string;
}

/** The public payment address of an account (what a @handle resolves to). */
export function paymentAddress(account: BenzoAccount): BenzoRecipient {
  return {
    spendPub: account.spendPub,
    viewPub: account.viewPub,
    mvkScalar: account.mvkScalar,
    label: account.label,
  };
}

export type TxType = "shield" | "send" | "receive" | "unshield" | "cashIn" | "cashOut";
export type TxStatus = "pending" | "proving" | "settled" | "failed";

export interface HistoryItem {
  type: TxType;
  amount: string; // stroops
  counterparty?: string; // address / handle / pubkey when known
  timestamp: number; // unix seconds
  status: TxStatus;
  txHash?: string;
  memo?: string;
}

function visibleHistoryAmount(amount: string | bigint): boolean {
  try {
    return BigInt(amount) > 0n;
  } catch {
    return false;
  }
}

export interface ProgressEvent {
  op: "send" | "shield" | "unshield";
  status: TxStatus;
  detail?: string;
  txHash?: string;
  provingMs?: number;
}

/** Async handle for a send: reports progress and resolves on settlement. */
export class SendHandle {
  status: TxStatus = "pending";
  result?: { txHash?: string; amount: bigint; recipient?: string; provingMs?: number; nullifier?: bigint; sorobanPublics?: string[] };
  error?: Error;
  private listeners: Array<(e: ProgressEvent) => void> = [];
  private resolveFn!: (r: SendHandle["result"]) => void;
  private rejectFn!: (e: Error) => void;
  readonly promise: Promise<SendHandle["result"]>;

  constructor(readonly id: string) {
    this.promise = new Promise((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
  }

  onProgress(cb: (e: ProgressEvent) => void): this {
    this.listeners.push(cb);
    return this;
  }

  /** await settlement */
  settled(): Promise<SendHandle["result"]> {
    return this.promise;
  }

  _emit(e: ProgressEvent): void {
    this.status = e.status;
    for (const l of this.listeners) l(e);
  }
  _resolve(r: SendHandle["result"]): void {
    this.status = "settled";
    this.result = r;
    this.resolveFn(r);
  }
  _reject(e: Error): void {
    this.status = "failed";
    this.error = e;
    this.rejectFn(e);
  }
}

/** Minimal anchor surface the facade needs for cashIn/cashOut (injected). */
export interface AnchorPort {
  authenticate(userSecret: string): Promise<string>;
  startDeposit(jwt: string, account: string, amount: string): Promise<{ id: string; url: string }>;
  startWithdraw(
    jwt: string,
    account: string,
    amount: string,
  ): Promise<{ id: string; withdraw_anchor_account?: string; withdraw_memo?: string }>;
  sim(jwt: string, id: string, payload: Record<string, unknown>): Promise<{ status: string; message?: string; stellar_transaction_id?: string }>;
  sendUsdcToAnchor(userSecret: string, anchorAccount: string, amount: string, memo: string): Promise<string>;
}

export interface BenzoClientOptions {
  cli: ChainClient;
  deployment: BenzoDeployment;
  circuits: CircuitSet;
  /** proving backend: NodeProver (CLI/server) or WasmProver (browser, client-side) */
  prover: ProverPort;
  rpcUrl: string;
  /** CLI identity that pays gas + read simulations */
  txSource: string;
  /** optional regulated-edge curator identity for ASP membership inserts */
  aspSource?: string;
  /** optional gasless relay (relayer pays XLM, takes USDC fee) */
  relayer?: { source: string; address: string };
  /** optional anchor for cashIn/cashOut */
  anchor?: AnchorPort;
  /** optional on-chain @handle registry */
  handleRegistry?: string;
  /** optional on-chain request/invoice registry (the pull primitive) */
  requestRegistry?: string;
  /**
   * optional durable store for incremental, restart-safe note discovery + the
   * transaction journal. When present, sync() resumes from a persisted cursor
   * (instead of re-scanning from ledger 1) and balances/history survive a
   * restart and the RPC event-retention window. When absent, sync() re-scans
   * from genesis each call (correct, just not incremental).
   */
  store?: KVStore;
  /**
   * Optional startup accelerator for hosted fresh accounts. If no scanner
   * snapshot exists yet, begin at latestLedger - lookback instead of ledger 1.
   * New accounts cannot have older notes; after the first scan, the durable
   * cursor becomes the source of truth.
   */
  initialScanLookbackLedgers?: number;
}

interface PoolWitnessSnapshot {
  v: 1;
  witnesses: Array<{
    leafIndex: number;
    commitment: string;
    root: string;
    pathIndices: string;
    pathElements: string[];
  }>;
}

/** 32-byte big-endian hex of a field element (guarded; for the registry record). */
const feHex32 = feHex;
function bytesHex(b: Uint8Array): string {
  return toHex(b);
}

// Default disclosure scope a note is sealed under (the HKDF info that derives
// the MVK→TVK). A caller can override per op so the seal scope matches the label
// an auditor's on-chain grant was issued for (e.g. "2026-Q2/corridor=ALL"),
// keeping the "auditor sees exactly the in-scope notes" claim coherent end-to-end.
const DISCLOSURE_SCOPE = "default";
let opCounter = 0;

/**
 * Plan which notes a 2-in joinsplit should spend for `amount`:
 *  - prefer the smallest single note that covers it (1 real input + a dummy),
 *  - else fall back to the two largest notes if together they cover it,
 *  - else return [] (uncoverable in one 2-in transfer).
 * The joinsplit circuit takes exactly two inputs, so we never need k>2 here;
 * change absorbs any overshoot. Pure + exported for unit testing.
 */
export function selectSpendNotes(notes: SpendableNote[], amount: bigint): SpendableNote[] {
  const desc = [...notes].sort((a, b) =>
    a.note.amount > b.note.amount ? -1 : a.note.amount < b.note.amount ? 1 : 0,
  );
  const single = [...desc].reverse().find((n) => n.note.amount >= amount);
  if (single) return [single];
  if (desc.length >= 2 && desc[0].note.amount + desc[1].note.amount >= amount) {
    return [desc[0], desc[1]];
  }
  return [];
}

function sameSpendPlan(a: SpendableNote[], b: SpendableNote[]): boolean {
  return a.length === b.length && a.every((n, i) => n.leafIndex === b[i]?.leafIndex);
}

function newestCoveringNote(notes: SpendableNote[], amount: bigint): SpendableNote | undefined {
  return notes
    .filter((n) => n.note.amount >= amount)
    .sort((a, b) => b.leafIndex - a.leafIndex)[0];
}

export class BenzoClient {
  readonly pool: BenzoPoolClient;
  scanner: NoteScanner;
  account!: BenzoAccount;
  private journal: HistoryItem[] = [];
  private poolWitnesses = new Map<string, AspMembershipWitness>();
  private assetIdCache?: bigint;

  constructor(readonly opts: BenzoClientOptions) {
    this.pool = new BenzoPoolClient(opts.cli, opts.deployment, opts.circuits, opts.txSource, opts.prover);
    this.scanner = new NoteScanner(opts.deployment.treeLevels, 1);
  }

  // ----------------------------------------------------------- account ----

  /** Reset per-account in-memory + durable-load state when the account changes. */
  private resetAccountState(): void {
    this.stateLoaded = false;
    this.journal = [];
    this.poolWitnesses = new Map();
    this.aspLeaves = [];
    this.aspCursor = 0;
    this.scanner = new NoteScanner(this.opts.deployment.treeLevels, 1);
  }

  /** Create a fresh in-memory account (no file). */
  createAccount(label?: string, stellarSecret?: string): BenzoAccount {
    this.account = createAccount({ label, stellarSecret });
    this.resetAccountState();
    return this.account;
  }

  /** Adopt an externally constructed account (e.g. derived from a claim secret). */
  useAccount(account: BenzoAccount): void {
    this.account = account;
    this.resetAccountState();
  }

  /** This account's public, shareable payment address. */
  address(): BenzoRecipient {
    return paymentAddress(this.account);
  }

  // -------------------------------------------------------------- sync ----

  private async assetId(): Promise<bigint> {
    if (this.assetIdCache === undefined) this.assetIdCache = await this.pool.assetId();
    return this.assetIdCache;
  }

  /**
   * Rebuild the scanner + Merkle/ASP mirrors from on-chain events. With a
   * durable store this is incremental (resume from the persisted cursor) and
   * restart-safe; without one it re-scans from genesis each call.
   */
  async sync(opts: { allowPoolMirrorGaps?: boolean; allowAspMirrorGaps?: boolean } = {}): Promise<void> {
    const { rpcUrl, deployment, store } = this.opts;
    if (!store) {
      // No durable store: full re-scan from genesis (correct, not incremental).
      this.scanner = new NoteScanner(deployment.treeLevels, 1);
      await syncFromRpc(this.scanner, rpcUrl, [deployment.pool, deployment.viewkeyAnchor], 1);
      this.pool.poolRebuild(this.scanner.orderedLeaves());
      const aspLeaves = await fetchAspLeaves(rpcUrl, deployment.aspMembership, 1);
      this.pool.aspRebuild(aspLeaves);
      return;
    }

    await this.loadStateOnce();

    // Pool + viewkey-anchor: resume the scanner from its persisted cursor so we
    // only fetch the delta; the durable snapshot keeps anything that has since
    // aged out of the RPC retention window.
    const poolFrom = this.scanner.cursorLedger > 0 ? Math.max(1, this.scanner.cursorLedger - 100) : 1;
    await syncFromRpc(this.scanner, rpcUrl, [deployment.pool, deployment.viewkeyAnchor], poolFrom);
    await store.set(this.key("scan"), JSON.stringify(this.scanner.snapshot()));
    let poolMirrorSynced = false;
    try {
      this.pool.poolRebuild(this.scanner.orderedLeaves());
      await this.pool.assertSynced();
      poolMirrorSynced = true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/commitment leaf \d+ missing from events|pool tree mirror out of sync/.test(msg)) throw e;
      // A previously persisted incremental snapshot can contain a hole or a
      // stale root if an older client crashed, missed a log window, or replayed
      // overlapping logs differently. Rebuild from genesis while RPC still has
      // events. If the oldest events already aged out, keep the retained suffix
      // as a public commitment index for storage-frontier witnesses.
      const previousScanner = this.scanner;
      const retainedScanner = new NoteScanner(deployment.treeLevels, 1);
      await syncFromRpc(retainedScanner, rpcUrl, [deployment.pool, deployment.viewkeyAnchor], 1);
      for (const rec of previousScanner.commitments) {
        if (rec && !retainedScanner.commitments[rec.leafIndex]) retainedScanner.commitments[rec.leafIndex] = rec;
      }
      for (const n of previousScanner.nullifiers) retainedScanner.nullifiers.add(n);
      for (const [key, value] of previousScanner.nullifierRecords) {
        if (!retainedScanner.nullifierRecords.has(key)) retainedScanner.nullifierRecords.set(key, value);
      }
      const seenBindings = new Set(retainedScanner.mvkBindings.map((b) => `${b.tag}:${toHex(b.mvkCt)}:${b.ledger}`));
      for (const binding of previousScanner.mvkBindings) {
        const key = `${binding.tag}:${toHex(binding.mvkCt)}:${binding.ledger}`;
        if (!seenBindings.has(key)) retainedScanner.mvkBindings.push(binding);
      }
      retainedScanner.cursorLedger = Math.max(retainedScanner.cursorLedger, previousScanner.cursorLedger);
      this.scanner = retainedScanner;
      try {
        this.pool.poolRebuild(this.scanner.orderedLeaves());
        await this.pool.assertSynced();
        await store.set(this.key("scan"), JSON.stringify(this.scanner.snapshot()));
        poolMirrorSynced = true;
      } catch (rebuildErr) {
        const rebuildMsg = String((rebuildErr as Error)?.message ?? rebuildErr);
        if (!/commitment leaf \d+ missing from events|pool tree mirror out of sync/.test(rebuildMsg)) {
          this.scanner = previousScanner;
          throw rebuildErr;
        }
        if (!opts.allowPoolMirrorGaps) {
          this.scanner = previousScanner;
          throw rebuildErr;
        }
        await store.set(this.key("scan"), JSON.stringify(this.scanner.snapshot()));
      }
    }

    // ASP allow-set: same incremental, persisted resume. Fresh shield callers
    // can opt into a storage-backed latest-leaf witness when the oldest ASP
    // events have aged out of testnet RPC retention and no durable snapshot
    // exists yet. Spend/read paths stay strict.
    let aspMirrorSynced = false;
    try {
      const aspFrom = this.aspCursor > 0 ? Math.max(1, this.aspCursor - 100) : 1;
      const asp = await fetchAspLeavesSince(rpcUrl, deployment.aspMembership, aspFrom, this.aspLeaves);
      this.aspLeaves = asp.leaves;
      this.aspCursor = asp.cursor;
      const aspSnap: AspSnapshot = {
        v: 1,
        cursorLedger: this.aspCursor,
        leaves: this.aspLeaves.map(String),
      };
      await store.set(this.globalKey("asp"), JSON.stringify(aspSnap));
      this.pool.aspRebuild(this.aspLeaves);
      aspMirrorSynced = true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!opts.allowAspMirrorGaps || !/ASP leaf index \d+ missing from events/.test(msg)) throw e;
    }
    if (!poolMirrorSynced && !opts.allowPoolMirrorGaps) {
      throw new Error("pool tree mirror out of sync");
    }
    if (!aspMirrorSynced && !opts.allowAspMirrorGaps) {
      throw new Error("ASP membership mirror is not synced to the on-chain root yet");
    }
  }

  /**
   * A shield first inserts the depositor into the ASP allow-set, then builds a
   * proof against that allow-tree. RPC/event indexing can lag the transaction,
   * and other users can insert between our pre-sync and our proof. Re-sync the
   * allow-set after the curator write and use the leaf index from the refreshed
   * ordered event set, so the witness is built against the same root the chain
   * will verify.
   */
  private async syncAspMembershipAndLocate(leaf: bigint): Promise<{ index: number; witness?: AspMembershipWitness }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await this.sync({ allowPoolMirrorGaps: true, allowAspMirrorGaps: true });
        const index = this.aspLeaves.findIndex((l) => l === leaf);
        if (index >= 0) {
          const onchainRoot = await this.pool.aspAllowRoot();
          if (this.pool.aspTree.root() === onchainRoot) return { index };
        }
      } catch (e) {
        lastErr = e;
      }
      try {
        const witness = await fetchLatestAspWitnessFromStorage(
          this.opts.rpcUrl,
          this.opts.deployment.aspMembership,
          this.opts.deployment.aspLevels,
          leaf,
        );
        return { index: witness.leafIndex, witness };
      } catch (e) {
        lastErr = e;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 250));
    }
    throw lastErr instanceof Error ? lastErr : new Error("ASP membership mirror is not synced to the on-chain root yet");
  }

  private async shieldWithFreshAspRoot(
    leaf: bigint,
    build: (aspLeafIndex: number, aspWitness?: AspMembershipWitness) => Parameters<BenzoPoolClient["shield"]>[0],
  ): Promise<Awaited<ReturnType<BenzoPoolClient["shield"]>>> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { index: aspLeafIndex, witness: aspWitness } = await this.syncAspMembershipAndLocate(leaf);
      try {
        return await this.pool.shield(build(aspLeafIndex, aspWitness));
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (attempt < 3 && /ASP membership mirror|on-chain root|WrongAspRoot|unknown root/i.test(msg)) {
          continue;
        }
        throw e;
      }
    }
    throw new Error("ASP membership mirror is not synced to the on-chain root yet");
  }

  /**
   * Spending needs a complete pool mirror so old or non-latest notes can produce
   * Merkle witnesses. Hosted read/shield paths may allow pool gaps and recover
   * the latest leaf from storage, but private sends/unshields should first try a
   * strict rebuild. If the deployment's early events really aged out, fall back
   * to the latest-leaf storage path and fail closed for older notes.
   */
  private async syncForSpend(): Promise<void> {
    try {
      await this.sync({ allowAspMirrorGaps: true });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/commitment leaf \d+ missing from events|pool tree mirror out of sync/i.test(msg)) {
        throw e;
      }
      await this.sync({ allowPoolMirrorGaps: true, allowAspMirrorGaps: true });
    }
  }

  // ----------------------------------------------------- persistence ------

  private stateLoaded = false;
  private aspLeaves: bigint[] = [];
  private aspCursor = 0;
  private persistChain: Promise<void> = Promise.resolve();

  /** Store keys are namespaced by the active account's public view key. */
  private key(kind: string): string {
    const ns = toHex(this.account.viewPub).slice(0, 16);
    return `benzo:${ns}:${kind}`;
  }

  private globalKey(kind: string): string {
    return `benzo:global:${kind}`;
  }

  private async initialScanStartLedger(): Promise<number> {
    const lookback = Number(this.opts.initialScanLookbackLedgers ?? 0);
    if (!Number.isFinite(lookback) || lookback <= 0) return 1;
    try {
      const server = new rpc.Server(this.opts.rpcUrl, { allowHttp: this.opts.rpcUrl.startsWith("http://") });
      const latest = await server.getLatestLedger();
      return Math.max(1, Number(latest.sequence) - Math.floor(lookback));
    } catch {
      return 1;
    }
  }

  /** Load persisted scanner snapshot, ASP set, and journal once per account. */
  private async loadStateOnce(): Promise<void> {
    const { store, deployment } = this.opts;
    if (!store || this.stateLoaded) return;
    const scanRaw = await store.get(this.key("scan"));
    this.scanner = scanRaw
      ? NoteScanner.restore(deployment.treeLevels, JSON.parse(scanRaw) as ScannerSnapshot)
      : new NoteScanner(deployment.treeLevels, await this.initialScanStartLedger());
    const aspRaw = await store.get(this.globalKey("asp"));
    if (aspRaw) {
      const snap = JSON.parse(aspRaw) as AspSnapshot;
      this.aspLeaves = snap.leaves.map((s) => BigInt(s));
      this.aspCursor = snap.cursorLedger;
    }
    const journalRaw = await store.get(this.key("journal"));
    if (journalRaw) this.journal = JSON.parse(journalRaw) as HistoryItem[];
    const witnessesRaw = await store.get(this.key("pool-witnesses"));
    if (witnessesRaw) {
      const snap = JSON.parse(witnessesRaw) as PoolWitnessSnapshot;
      if (snap.v === 1) {
        this.poolWitnesses = new Map(
          snap.witnesses.map((w) => [
            this.poolWitnessKey(w.leafIndex, BigInt(w.commitment)),
            {
              leafIndex: w.leafIndex,
              root: BigInt(w.root),
              pathIndices: BigInt(w.pathIndices),
              pathElements: w.pathElements.map((p) => BigInt(p)),
            },
          ]),
        );
      }
    }
    this.stateLoaded = true;
  }

  /** Await all pending durable writes (call before process exit). */
  async flush(): Promise<void> {
    await this.persistChain;
  }

  private poolWitnessKey(leafIndex: number, commitment: bigint): string {
    return `${leafIndex}:${commitment.toString()}`;
  }

  private rememberPoolWitness(leafIndex: number, commitment: bigint, witness: AspMembershipWitness): void {
    if (witness.leafIndex !== leafIndex || witness.pathIndices !== BigInt(leafIndex)) return;
    this.poolWitnesses.set(this.poolWitnessKey(leafIndex, commitment), witness);
    const store = this.opts.store;
    if (!store) return;
    const snap: PoolWitnessSnapshot = {
      v: 1,
      witnesses: [...this.poolWitnesses.entries()].map(([key, w]) => {
        const [leafIndexPart, commitment] = key.split(":");
        return {
          leafIndex: Number(leafIndexPart),
          commitment,
          root: w.root.toString(),
          pathIndices: w.pathIndices.toString(),
          pathElements: w.pathElements.map((p) => p.toString()),
        };
      }),
    };
    this.persistChain = this.persistChain
      .then(() => store.set(this.key("pool-witnesses"), JSON.stringify(snap)))
      .catch((e: unknown) => {
        this.lastPersistError = e instanceof Error ? e : new Error(String(e));
      });
  }

  private async cachedPoolWitness(input: SpendableNote): Promise<AspMembershipWitness | undefined> {
    const witness = this.poolWitnesses.get(this.poolWitnessKey(input.leafIndex, noteCommitment(input.note)));
    if (!witness) return undefined;
    try {
      if (await this.pool.isKnownPoolRoot(witness.root)) return witness;
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async preAppendPoolFrontier() {
    return fetchPoolStorageFrontier(
      this.opts.rpcUrl,
      this.opts.deployment.merkle,
      this.opts.deployment.treeLevels,
    );
  }

  private cacheAppendedPoolWitnesses(
    frontier: Awaited<ReturnType<BenzoClient["preAppendPoolFrontier"]>> | undefined,
    leafIndices: number[],
    commitments: bigint[],
  ): void {
    if (!frontier || leafIndices.length !== commitments.length || commitments.length === 0) return;
    try {
      const witnesses = appendPoolWitnessesFromFrontier(
        this.opts.deployment.treeLevels,
        frontier,
        commitments,
      );
      for (let i = 0; i < witnesses.length; i++) {
        if (witnesses[i].leafIndex === leafIndices[i]) {
          this.rememberPoolWitness(leafIndices[i], commitments[i], witnesses[i]);
        }
      }
    } catch {
      /* best effort: the normal storage/suffix paths still apply */
    }
  }

  // ----------------------------------------------------- balance/history --

  /** Spendable notes owned by this account (decryptable + unspent). */
  spendableNotes(): SpendableNote[] {
    return this.scanner
      .spendable(this.account.viewSecret, this.account.spendSk)
      .map((d) => ({
        note: {
          amount: d.plain.amount,
          recipientPk: d.plain.recipientPk,
          blinding: d.plain.blinding,
          assetId: d.plain.assetId,
        },
        spendSk: this.account.spendSk,
        leafIndex: d.leafIndex,
      }));
  }

  /** Aggregated spendable balance (stroops). */
  async getBalance(): Promise<bigint> {
    return this.spendableNotes().reduce((s, n) => s + n.note.amount, 0n);
  }

  // ------------------------------------------------ org treasury (M-of-N) ----
  // The business treasury is held as ORG notes (recipientPk = orgRecipientPk),
  // spendable ONLY via pool.transfer_org under a ≥threshold member quorum. The
  // org identity (member EdDSA keys + group key) is derived deterministically
  // from this account's seed, so the same org is reproduced on every device and
  // the treasury is rediscovered from chain (no backend storage).

  private orgCache = new Map<string, OrgIdentity>();

  /** This account's M-of-N org identity (deterministic; cached per orgId). */
  async orgIdentity(opts: {
    orgId: string | number;
    memberCount: number;
    threshold: bigint;
  }): Promise<OrgIdentity> {
    const key = `${opts.orgId}:${opts.memberCount}:${opts.threshold}`;
    let id = this.orgCache.get(key);
    if (!id) {
      id = await deriveOrgIdentity({
        seed: this.account.mvkSecret,
        orgId: opts.orgId,
        memberCount: opts.memberCount,
        threshold: opts.threshold,
      });
      this.orgCache.set(key, id);
    }
    return id;
  }

  /** Dual-controlled treasury notes this client can rediscover from chain. */
  orgTreasuryNotes(org: OrgIdentity): { note: Note; leafIndex: number }[] {
    return this.scanner
      .orgSpendable(this.account.viewSecret, org.recipientPk, org.akGroup)
      .map((d) => ({
        note: {
          amount: d.plain.amount,
          recipientPk: d.plain.recipientPk,
          blinding: d.plain.blinding,
          assetId: d.plain.assetId,
        },
        leafIndex: d.leafIndex,
      }));
  }

  /** Aggregated dual-controlled treasury balance (stroops). */
  async orgTreasuryBalance(org: OrgIdentity): Promise<bigint> {
    await this.sync();
    return this.orgTreasuryNotes(org).reduce((s, n) => s + n.note.amount, 0n);
  }

  /** Shield real USDC into the org treasury (an M-of-N owned org note). */
  async fundTreasury(opts: {
    org: OrgIdentity;
    amount: bigint;
    fromAddress: string;
    fromSource: string;
    scope?: string;
    mvkWitness?: AspMembershipWitness;
  }): Promise<{ txHash?: string; leafIndex: number; note: Note }> {
    await this.sync({ allowPoolMirrorGaps: true, allowAspMirrorGaps: true });
    await this.assertDepositorCanFund(opts.fromAddress, opts.amount);
    const assetId = await this.assetId();

    const aspBlinding = randomFieldElement();
    const depositorScalar = await this.pool.depositorScalar(opts.fromAddress);
    const leaf = aspLeaf(depositorScalar, aspBlinding);
    await this.opts.cli.invoke({
      contractId: this.opts.deployment.aspMembership,
      source: this.opts.aspSource ?? this.opts.txSource,
      send: true,
      fnArgs: ["insert_leaf", "--leaf", leaf.toString()],
    });
    const orgNote: Note = {
      amount: opts.amount,
      recipientPk: opts.org.recipientPk,
      blinding: randomFieldElement(),
      assetId,
    };
    const plain = encodeNotePlain({ ...orgNote });
    const tvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
    const noteCt = seal(plain, this.account.viewPub).bytes;
    const mvkCt = seal(plain, tvk.publicKey).bytes;
    const poolFrontier = await this.preAppendPoolFrontier().catch(() => undefined);
    const res = await this.shieldWithFreshAspRoot(leaf, (aspLeafIndex, aspWitness) => ({
      source: opts.fromSource,
      from: opts.fromAddress,
      note: orgNote,
      mvkPubScalar: this.account.mvkScalar,
      aspBlinding,
      aspLeafIndex,
      aspWitness,
      mvkWitness: opts.mvkWitness,
      noteCt,
      mvkCt,
    }));
    this.cacheAppendedPoolWitnesses(poolFrontier, [res.leafIndex], [res.commitment]);
    this.record({
      type: "shield",
      amount: opts.amount.toString(),
      counterparty: "treasury",
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: res.txHash,
    });
    return { txHash: res.txHash, leafIndex: res.leafIndex, note: orgNote };
  }

  /**
   * Confidential payroll from the org treasury — one `pool.transfer_org` per
   * payout under a ≥threshold member quorum (dual control enforced in-circuit).
   * The treasury note covering the whole run is spent and its remainder rolls
   * into a fresh CHANGE org note each time, so the treasury stays confidential
   * AND dual-controlled across the run. Individual salaries are never revealed
   * on-chain (each payout is its own confidential transfer).
   *
   * `signerIndices` are the approving members (≥ threshold) — the cryptographic
   * embodiment of the maker-checker quorum. `sign(memberIndex, message)` lets
   * each approver self-sign client-side; omit it to sign from the derived keys.
   */
  async orgPayroll(opts: {
    org: OrgIdentity;
    payouts: Array<{ to: BenzoRecipient; amount: bigint; memo?: string }>;
    signerIndices: number[];
    relayer: string;
    scope?: string;
    sign?: (memberIndex: number, message: bigint) => Promise<OrgSignature>;
  }): Promise<Array<{ to: BenzoRecipient; amount: bigint; txHash?: string; provingMs: number }>> {
    if (!this.opts.circuits.joinsplitOrg) {
      throw new Error("orgPayroll requires circuits.joinsplitOrg");
    }
    await this.sync();
    const assetId = await this.assetId();
    const org = opts.org;
    const total = opts.payouts.reduce((s, p) => s + p.amount, 0n);

    // One treasury note must cover the whole run (the change chains across it).
    const covering = this.orgTreasuryNotes(org)
      .filter((n) => n.note.amount >= total)
      .sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1))[0];
    if (!covering) {
      const bal = this.orgTreasuryNotes(org).reduce((s, n) => s + n.note.amount, 0n);
      throw new Error(
        `no single treasury note covers the payroll total ${total} (largest-coverable check failed; treasury ${bal})`,
      );
    }

    const tvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
    let current: { note: Note; leafIndex: number } = covering;
    const results: Array<{ to: BenzoRecipient; amount: bigint; txHash?: string; provingMs: number }> = [];

    for (const p of opts.payouts) {
      const change = current.note.amount - p.amount; // fee 0
      const employeeNote = newNote(p.amount, p.to.spendPub, assetId);
      const employeePlain = encodeNotePlain({ ...employeeNote, memo: p.memo });
      const changeNote: Note = {
        amount: change,
        recipientPk: org.recipientPk,
        blinding: randomFieldElement(),
        assetId,
      };
      const changePlain = encodeNotePlain({ ...changeNote });
      const r = await this.pool.transferOrg({
        source: this.opts.txSource,
        org,
        signerIndices: opts.signerIndices,
        input: current,
        outputs: [
          { note: employeeNote, mvkPubScalar: this.account.mvkScalar },
          { note: changeNote, mvkPubScalar: this.account.mvkScalar },
        ],
        fee: 0n,
        relayer: opts.relayer,
        noteCts: [seal(employeePlain, p.to.viewPub).bytes, seal(changePlain, this.account.viewPub).bytes],
        mvkCts: [seal(employeePlain, tvk.publicKey).bytes, seal(changePlain, tvk.publicKey).bytes],
        sign: opts.sign,
      });
      this.record({
        type: "send",
        amount: p.amount.toString(),
        counterparty: p.to.label ?? "contractor",
        timestamp: Math.floor(Date.now() / 1000),
        status: "settled",
        txHash: r.txHash,
      });
      results.push({ to: p.to, amount: p.amount, txHash: r.txHash, provingMs: r.provingMs });
      current = { note: changeNote, leafIndex: r.outLeafIndices[1] }; // chain the change
    }
    return results;
  }

  /**
   * BATCHED confidential payroll — settle a run with ONE `batch_transfer_org` per
   * chunk (one combined on-chain verification) instead of one tx per payout.
   *
   * Unlike `orgPayroll` (which chains a single covering note's change across
   * payouts), a batch can't chain (all proofs in a tx bind the SAME pre-batch
   * root, and a change note isn't on-chain mid-tx). So each payout spends a
   * DISTINCT existing treasury note that covers it. Per-tx N is capped at
   * `maxPerTx` (default 8, inside the ~10-15 measured real-testnet limit) and
   * larger runs are auto-chunked into multiple batch txs (re-syncing between
   * chunks so change notes become spendable). HONEST: this batches VERIFICATION,
   * not settlement — the win is one pairing check + one tx per chunk, not "all in
   * one proof".
   */
  async orgBatchPayroll(opts: {
    org: OrgIdentity;
    payouts: Array<{ to: BenzoRecipient; amount: bigint; memo?: string }>;
    signerIndices: number[];
    relayer: string;
    scope?: string;
    sign?: (memberIndex: number, message: bigint) => Promise<OrgSignature>;
    /** max payouts per batch tx (default 8; auto-chunks larger runs). */
    maxPerTx?: number;
  }): Promise<Array<{ to: BenzoRecipient; amount: bigint; txHash?: string; provingMs: number }>> {
    if (!this.opts.circuits.joinsplitOrg) {
      throw new Error("orgBatchPayroll requires circuits.joinsplitOrg");
    }
    const org = opts.org;
    const assetId = await this.assetId();
    const tvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
    // MEASURED real-testnet cap: a full batch_transfer_org tops out at ~3 org
    // spends/tx (N=3 settles, N=4 exceeds the 100M-instruction budget). The
    // integrated entrypoint caps far below verify_batch-alone (~16) because each
    // spend also drives 4 cross-contract state writes (2 nullifier spends + 2
    // viewkey binds) + the JSPLITORG verify, which sum. Larger runs auto-chunk.
    const cap = Math.max(1, Math.min(opts.maxPerTx ?? 3, 3));
    const results: Array<{ to: BenzoRecipient; amount: bigint; txHash?: string; provingMs: number }> = [];

    for (let off = 0; off < opts.payouts.length; off += cap) {
      const chunk = opts.payouts.slice(off, off + cap);
      await this.sync();

      // Assign a DISTINCT covering treasury note to each payout (largest-first,
      // each note used at most once — the contract also rejects intra-batch
      // double-spends, but we must not even propose one).
      const avail = this.orgTreasuryNotes(org)
        .slice()
        .sort((a, b) => (a.note.amount < b.note.amount ? 1 : -1));
      const used = new Set<number>();
      const spends = chunk.map((p) => {
        const idx = avail.findIndex((n, i) => !used.has(i) && n.note.amount >= p.amount);
        if (idx < 0) {
          throw new Error(
            `orgBatchPayroll: treasury lacks a distinct note covering ${p.amount} for this batch ` +
              `(have ${avail.length - used.size} free notes). Split the treasury into per-payout notes first, ` +
              `or lower maxPerTx.`,
          );
        }
        used.add(idx);
        const input = avail[idx];
        const change = input.note.amount - p.amount; // fee 0
        const employeeNote = newNote(p.amount, p.to.spendPub, assetId);
        const employeePlain = encodeNotePlain({ ...employeeNote, memo: p.memo });
        const changeNote: Note = {
          amount: change,
          recipientPk: org.recipientPk,
          blinding: randomFieldElement(),
          assetId,
        };
        const changePlain = encodeNotePlain({ ...changeNote });
        return {
          org,
          signerIndices: opts.signerIndices,
          input,
          outputs: [
            { note: employeeNote, mvkPubScalar: this.account.mvkScalar },
            { note: changeNote, mvkPubScalar: this.account.mvkScalar },
          ] as [{ note: Note; mvkPubScalar: bigint }, { note: Note; mvkPubScalar: bigint }],
          fee: 0n,
          relayer: opts.relayer,
          noteCts: [seal(employeePlain, p.to.viewPub).bytes, seal(changePlain, this.account.viewPub).bytes] as [Uint8Array, Uint8Array],
          mvkCts: [seal(employeePlain, tvk.publicKey).bytes, seal(changePlain, tvk.publicKey).bytes] as [Uint8Array, Uint8Array],
          sign: opts.sign,
        };
      });

      const res = await this.pool.batchTransferOrg({ source: this.opts.txSource, spends });
      chunk.forEach((p, i) => {
        this.record({
          type: "send",
          amount: p.amount.toString(),
          counterparty: p.to.label ?? "contractor",
          timestamp: Math.floor(Date.now() / 1000),
          status: "settled",
          txHash: res.txHash,
        });
        results.push({ to: p.to, amount: p.amount, txHash: res.txHash, provingMs: res.spends[i]?.provingMs ?? 0 });
      });
    }
    return results;
  }

  /**
   * Typed transaction history: the local journal (self-initiated ops with
   * counterparties) reconciled with on-chain receives discovered by scanning.
   */
  getHistory(): HistoryItem[] {
    const items: HistoryItem[] = this.journal.filter((j) => visibleHistoryAmount(j.amount));

    // Incoming notes this account can decrypt that aren't journal entries.
    const journaledTx = new Set(this.journal.map((j) => j.txHash).filter(Boolean));
    const seenIncoming = new Set<string>();
    const discovered = this.scanner.scan(this.account.viewSecret);
    const ownSpendTx = new Set<string>();
    for (const d of discovered) {
      const spentIn = this.scanner.nullifierTxHash(noteNullifier(this.account.spendSk, BigInt(d.leafIndex)));
      if (spentIn) ownSpendTx.add(spentIn);
    }
    for (const d of discovered) {
      if (!visibleHistoryAmount(d.plain.amount)) continue;
      const rec = this.scanner.commitments[d.leafIndex];
      if (!rec || journaledTx.has(rec.txHash)) continue;
      if (ownSpendTx.has(rec.txHash)) continue;
      const key = `${rec.txHash}:${d.plain.amount.toString()}:${d.plain.recipientPk.toString()}:${d.plain.blinding.toString()}`;
      if (seenIncoming.has(key)) continue;
      seenIncoming.add(key);
      // Skip self-change notes already represented by a journaled send/shield.
      items.push({
        type: "receive",
        amount: d.plain.amount.toString(),
        counterparty: "shielded",
        timestamp: rec.ts,
        status: "settled",
        txHash: rec.txHash,
        memo: d.plain.memo,
      });
    }
    return items.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Public nullifiers observed for a settlement transaction. */
  nullifiersForTxHash(txHash: string): bigint[] {
    return [...this.scanner.nullifierRecords.values()]
      .filter((r) => r.txHash === txHash)
      .map((r) => r.nullifier);
  }

  /** Transaction hash that spent a given nullifier, if scanner state has it. */
  txHashForNullifier(nullifier: bigint): string | undefined {
    return this.scanner.nullifierTxHash(nullifier);
  }

  /** Last durable-write failure, if any (so `flush()` callers can detect a
   * journal that didn't persist instead of it being silently swallowed). */
  lastPersistError?: Error;

  private record(item: HistoryItem): void {
    this.journal.push(item);
    const store = this.opts.store;
    if (store) {
      // Snapshot now; serialize writes through the persist chain (no races).
      const snapshot = JSON.stringify(this.journal);
      this.persistChain = this.persistChain
        .then(() => store.set(this.key("journal"), snapshot))
        .catch((e: unknown) => {
          this.lastPersistError = e instanceof Error ? e : new Error(String(e));
        });
    }
  }

  // ------------------------------------------------------------ shield ----

  /**
   * Shield public USDC into a note owned by this account. Ensures the
   * depositor address is ASP-allowlisted (curator op) first.
   */
  /**
   * Advisory pre-flight: surface a clear "fund a USDC trustline first" instead
   * of a raw SAC error mid-shield. Only blocks when we can positively read a
   * balance below the deposit; a read hiccup (including the SAC `balance`
   * erroring when there is no trustline at all) falls through to the
   * authoritative on-chain transfer rather than false-blocking a valid deposit.
   */
  private async assertDepositorCanFund(fromAddress: string, amount: bigint): Promise<void> {
    try {
      const bal = await this.opts.cli.view(this.opts.deployment.token, this.opts.txSource, [
        "balance",
        "--id",
        fromAddress,
      ]);
      const have =
        typeof bal === "bigint"
          ? bal
          : typeof bal === "string" || typeof bal === "number"
            ? BigInt(bal)
            : null;
      if (have !== null && have < amount) {
        throw new Error(
          `depositor ${fromAddress} has insufficient USDC (${have.toString()} < ${amount.toString()}); add and fund a USDC trustline first (e.g. \`benzo onboard\`)`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("insufficient USDC")) throw e;
      // else: read failure / no trustline — let the on-chain transfer decide.
    }
  }

  async shield(opts: {
    amount: bigint;
    fromAddress: string; // public depositor G-address (must auth the SAC pull)
    fromSource: string; // CLI identity authorizing the deposit
    scope?: string; // disclosure scope to seal the MVK ciphertext under
    mvkWitness?: AspMembershipWitness;
  }): Promise<{ txHash?: string; leafIndex: number; commitment: bigint; note: Note; provingMs: number; sorobanPublics: string[] }> {
    await this.sync({ allowPoolMirrorGaps: true, allowAspMirrorGaps: true });
    await this.assertDepositorCanFund(opts.fromAddress, opts.amount);
    const assetId = await this.assetId();

    // ASP allow-membership (regulated edge): curator inserts the depositor.
    const aspBlinding = randomFieldElement();
    const depositorScalar = await this.pool.depositorScalar(opts.fromAddress);
    const leaf = aspLeaf(depositorScalar, aspBlinding);
    await this.opts.cli.invoke({
      contractId: this.opts.deployment.aspMembership,
      source: this.opts.aspSource ?? this.opts.txSource,
      send: true,
      fnArgs: ["insert_leaf", "--leaf", leaf.toString()],
    });
    const note = newNote(opts.amount, this.account.spendPub, assetId);
    const plain = encodeNotePlain({ ...note });
    const tvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
    const noteCt = seal(plain, this.account.viewPub).bytes;
    const mvkCt = seal(plain, tvk.publicKey).bytes;
    const poolFrontier = await this.preAppendPoolFrontier().catch(() => undefined);
    const res = await this.shieldWithFreshAspRoot(leaf, (aspLeafIndex, aspWitness) => ({
      source: opts.fromSource,
      from: opts.fromAddress,
      note,
      mvkPubScalar: this.account.mvkScalar,
      aspBlinding,
      aspLeafIndex,
      aspWitness,
      mvkWitness: opts.mvkWitness,
      noteCt,
      mvkCt,
    }));
    this.cacheAppendedPoolWitnesses(poolFrontier, [res.leafIndex], [res.commitment]);
    this.record({
      type: "shield",
      amount: opts.amount.toString(),
      counterparty: opts.fromAddress,
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: res.txHash,
    });
    return { txHash: res.txHash, leafIndex: res.leafIndex, commitment: res.commitment, note, provingMs: res.provingMs, sorobanPublics: res.proof.sorobanPublics };
  }

  // -------------------------------------------------------------- send ----

  /**
   * Private send to a recipient. Returns immediately with a SendHandle that
   * reports pending → proving → settled and resolves on settlement.
   */
  send(opts: {
    amount: bigint;
    to: BenzoRecipient;
    memo?: string;
    useRelayer?: boolean;
    scope?: string; // disclosure scope to seal the MVK ciphertexts under
    mvkWitness?: AspMembershipWitness;
  }): SendHandle {
    const handle = new SendHandle(`send-${++opCounter}`);
    // Kick off async work without blocking the caller (optimistic UI).
    void this.runSend(handle, opts);
    return handle;
  }

  private async runSend(
    handle: SendHandle,
    opts: { amount: bigint; to: BenzoRecipient; memo?: string; useRelayer?: boolean; scope?: string; mvkWitness?: AspMembershipWitness },
  ): Promise<void> {
    try {
      handle._emit({ op: "send", status: "pending", detail: "selecting note" });
      await this.syncForSpend();
      const assetId = await this.assetId();

      // Spend one covering note (+ a dummy), or two notes when no single note
      // covers the amount — the joinsplit circuit takes two inputs either way.
      //
      // On long-lived testnet deployments RPC event retention can leave the
      // local pool mirror gapped. The Merkle contract storage can recover a
      // witness for the latest commitment leaf, not for arbitrary old leaves.
      // So for single-note sends we try the newest covering note first, then
      // fall back to the usual smallest-covering plan when the mirror is synced.
      const spendable = this.spendableNotes();
      const primary = selectSpendNotes(spendable, opts.amount);
      if (primary.length === 0) throw new Error("insufficient spendable balance");
      const newest = newestCoveringNote(spendable, opts.amount);
      const plans: SpendableNote[][] = [];
      if (newest) plans.push([newest]);
      if (!plans.some((p) => sameSpendPlan(p, primary))) plans.push(primary);
      let selected = primary;
      let inputs: [SpendableNote, SpendableNote] =
        primary.length === 2
          ? [primary[0], primary[1]]
          : [primary[0], this.pool.makeDummyInput(assetId)];
      let inputWitnesses: [
        Awaited<ReturnType<BenzoClient["spendWitnessForSelectedNote"]>> | undefined,
        Awaited<ReturnType<BenzoClient["spendWitnessForSelectedNote"]>> | undefined,
      ] | undefined;
      let lastWitnessErr: unknown;
      for (const plan of plans) {
        const candidateInputs: [SpendableNote, SpendableNote] =
          plan.length === 2
            ? [plan[0], plan[1]]
            : [plan[0], this.pool.makeDummyInput(assetId)];
        try {
          inputWitnesses = await Promise.all(
            candidateInputs.map((input) => input.note.amount === 0n ? undefined : this.spendWitnessForSelectedNote(input)),
          ) as [
            Awaited<ReturnType<BenzoClient["spendWitnessForSelectedNote"]>> | undefined,
            Awaited<ReturnType<BenzoClient["spendWitnessForSelectedNote"]>> | undefined,
          ];
          selected = plan;
          inputs = candidateInputs;
          break;
        } catch (e) {
          lastWitnessErr = e;
          if (!/pool witness unavailable/i.test(String((e as Error)?.message ?? e))) throw e;
        }
      }
      if (!inputWitnesses) throw lastWitnessErr instanceof Error ? lastWitnessErr : new Error("pool witness unavailable");
      const totalIn = selected.reduce((s, n) => s + n.note.amount, 0n);
      const change = totalIn - opts.amount;

      const senderTvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
      const recipNote = newNote(opts.amount, opts.to.spendPub, assetId);
      const recipPlain = encodeNotePlain({ ...recipNote, memo: opts.memo });
      const changeNote = newNote(change, this.account.spendPub, assetId);
      const changePlain = encodeNotePlain({ ...changeNote });

      // Each output is a unit: its in-circuit slot (commitment + MVK tag) and the
      // two ciphertexts must stay aligned.
      const recipBundle = {
        output: { note: recipNote, mvkPubScalar: this.account.mvkScalar },
        noteCt: seal(recipPlain, opts.to.viewPub).bytes,
        mvkCt: seal(recipPlain, senderTvk.publicKey).bytes,
      };
      const changeBundle = {
        output: { note: changeNote, mvkPubScalar: this.account.mvkScalar },
        noteCt: seal(changePlain, this.account.viewPub).bytes,
        mvkCt: seal(changePlain, senderTvk.publicKey).bytes,
      };
      // Privacy: randomize output order so the change note isn't always in slot 1
      // — otherwise an observer learns which output is the payment vs the change.
      // Tornado-nova shuffles outputs for exactly this reason; discovery is
      // order-independent (the recipient finds its note by view tag, any slot).
      const [b0, b1] =
        (randomBytes(1)[0] & 1) === 1 ? [changeBundle, recipBundle] : [recipBundle, changeBundle];

      handle._emit({ op: "send", status: "proving", detail: "generating Groth16 proof" });

      const relay = opts.useRelayer && this.opts.relayer ? this.makeRelay() : undefined;
      const poolFrontier = await this.preAppendPoolFrontier().catch(() => undefined);
      const tr = await this.pool.transfer({
        source: this.opts.relayer && opts.useRelayer ? this.opts.relayer.source : this.opts.txSource,
        relay,
        inputs,
        outputs: [b0.output, b1.output],
        fee: 0n,
        relayer: this.opts.relayer?.address ?? (await this.opts.cli.keyAddress(this.opts.txSource)),
        noteCts: [b0.noteCt, b1.noteCt],
        mvkCts: [b0.mvkCt, b1.mvkCt],
        inputWitnesses,
        outputMvkWitnesses: [opts.mvkWitness, opts.mvkWitness],
      });
      this.cacheAppendedPoolWitnesses(poolFrontier, tr.outLeafIndices, tr.outCommitments);

      this.record({
        type: "send",
        amount: opts.amount.toString(),
        counterparty: opts.to.label ?? `pk:${opts.to.spendPub.toString().slice(0, 10)}…`,
        timestamp: Math.floor(Date.now() / 1000),
        status: "settled",
        txHash: tr.txHash,
        memo: opts.memo,
      });
      handle._emit({ op: "send", status: "settled", txHash: tr.txHash, provingMs: tr.provingMs });
      handle._resolve({ txHash: tr.txHash, amount: opts.amount, recipient: opts.to.label, provingMs: tr.provingMs, nullifier: tr.nullifiers[0], sorobanPublics: tr.proof.sorobanPublics });
    } catch (e) {
      handle._emit({ op: "send", status: "failed", detail: (e as Error).message });
      handle._reject(e as Error);
    }
  }

  /** Pick the smallest single note that covers `amount` (simple coin select). */
  private selectNote(amount: bigint, notes: SpendableNote[] = this.spendableNotes()): SpendableNote | null {
    const covering = notes
      .filter((n) => n.note.amount >= amount)
      .sort((a, b) => (a.note.amount < b.note.amount ? -1 : 1));
    return covering[0] ?? null;
  }

  private async spendWitnessForSelectedNote(input: SpendableNote): Promise<AspMembershipWitness | undefined> {
    const commitment = noteCommitment(input.note);
    const cached = await this.cachedPoolWitness(input);
    if (cached) return cached;

    let storageErr: unknown;
    try {
      const witness = await fetchLatestPoolWitnessFromStorage(
        this.opts.rpcUrl,
        this.opts.deployment.merkle,
        this.opts.deployment.treeLevels,
        commitment,
      );
      if (witness.leafIndex === input.leafIndex) {
        this.rememberPoolWitness(input.leafIndex, commitment, witness);
        return witness;
      }
      storageErr = new Error(`latest pool leaf is ${witness.leafIndex}, selected note is ${input.leafIndex}`);
    } catch (e) {
      storageErr = e;
    }

    try {
      const witness = await fetchPoolWitnessFromStorageWithKnownSuffix(
        this.opts.rpcUrl,
        this.opts.deployment.merkle,
        this.opts.deployment.treeLevels,
        commitment,
        input.leafIndex,
        this.scanner.commitments.flatMap((rec) =>
          rec ? [{ leafIndex: rec.leafIndex, commitment: rec.commitment }] : [],
        ),
      );
      this.rememberPoolWitness(input.leafIndex, commitment, witness);
      return witness;
    } catch (e) {
      storageErr = e;
    }

    try {
      await this.pool.assertSynced();
      return undefined;
    } catch (e) {
      const reason = String((storageErr as Error)?.message ?? storageErr ?? (e as Error)?.message ?? e);
      throw new Error(`pool witness unavailable for selected note ${input.leafIndex}: ${reason}`);
    }
  }

  private makeRelay() {
    const { relayer, deployment, cli } = this.opts;
    if (!relayer) return undefined;
    return async (a: {
      pool: string; root: string; nullifier0: string; nullifier1: string;
      outCommitment0: string; outCommitment1: string; fee: string; relayerAddress: string;
      mvkTag0: string; mvkTag1: string; noteCt0: string; noteCt1: string;
      mvkCt0: string; mvkCt1: string; registeredMvkRoot: string; proof: string;
    }) => {
      const submitter = await cli.keyAddress(relayer.source);
      const res = await cli.invoke({
        contractId: deployment.pool,
        source: relayer.source,
        send: true,
        fnArgs: transferRelayFnArgs({ ...a, submitter }),
      });
      return { txHash: res.txHash };
    };
  }

  // ---------------------------------------------------------- unshield ----

  /** Unshield public USDC to a Stellar address (proof-of-innocence enforced). */
  async unshield(opts: {
    amount: bigint;
    toAddress: string;
    scope?: string; // disclosure scope to seal the change-note MVK ciphertext under
    mvkWitness?: AspMembershipWitness;
  }): Promise<{ txHash?: string; nullifier: bigint; provingMs: number; consolidationTxs?: string[]; sorobanPublics: string[] }> {
    await this.syncForSpend();
    const assetId = await this.assetId();
    const scope = opts.scope ?? DISCLOSURE_SCOPE;
    let working = this.spendableNotes();
    let input = this.selectNote(opts.amount, working);
    let consolidationProvingMs = 0;
    const consolidationTxs: string[] = [];

    // The withdraw circuit is one-input. If funds are split across smaller
    // notes, privately merge the two largest notes to self until one note covers
    // the public edge amount. Amounts stay hidden inside joinsplits; only the
    // final unshield exposes the requested off-ramp amount.
    const maxConsolidations = Math.max(0, working.filter((n) => n.note.amount > 0n).length - 1);
    for (let i = 0; !input && i < maxConsolidations; i++) {
      const total = working.reduce((s, n) => s + n.note.amount, 0n);
      if (total < opts.amount) throw new Error("insufficient spendable balance");

      const pair = working
        .filter((n) => n.note.amount > 0n)
        .sort((a, b) => (a.note.amount > b.note.amount ? -1 : a.note.amount < b.note.amount ? 1 : 0))
        .slice(0, 2);
      if (pair.length < 2) {
        throw new Error(
          `shielded balance is too fragmented to unshield ${stroopsToUsdc(opts.amount)} USDC in one operation`,
        );
      }

      const totalIn = pair[0].note.amount + pair[1].note.amount;
      const mergedAmount = totalIn >= opts.amount ? opts.amount : totalIn;
      const changeAmount = totalIn - mergedAmount;
      const tvk = deriveTvk(this.account.mvkSecret, scope);
      const mergedNote = newNote(mergedAmount, this.account.spendPub, assetId);
      const changeNote = newNote(changeAmount, this.account.spendPub, assetId);
      const mergedPlain = encodeNotePlain({ ...mergedNote });
      const changePlain = encodeNotePlain({ ...changeNote });
      const mergedBundle = {
        kind: "merged" as const,
        note: mergedNote,
        output: { note: mergedNote, mvkPubScalar: this.account.mvkScalar },
        noteCt: seal(mergedPlain, this.account.viewPub).bytes,
        mvkCt: seal(mergedPlain, tvk.publicKey).bytes,
      };
      const changeBundle = {
        kind: "change" as const,
        note: changeNote,
        output: { note: changeNote, mvkPubScalar: this.account.mvkScalar },
        noteCt: seal(changePlain, this.account.viewPub).bytes,
        mvkCt: seal(changePlain, tvk.publicKey).bytes,
      };
      // This consolidation is immediately followed by an unshield. On long-lived
      // testnet deployments, storage-backed witness recovery is most reliable
      // for the latest inserted leaf, so put the note we will spend next in the
      // second slot.
      const bundles = [changeBundle, mergedBundle] as const;
      const inputWitnesses = await Promise.all(
        pair.map((input) => this.spendWitnessForSelectedNote(input)),
      ) as [
        Awaited<ReturnType<BenzoClient["spendWitnessForSelectedNote"]>>,
        Awaited<ReturnType<BenzoClient["spendWitnessForSelectedNote"]>>,
      ];
      const poolFrontier = await this.preAppendPoolFrontier().catch(() => undefined);
      const tr = await this.pool.transfer({
        source: this.opts.txSource,
        inputs: [pair[0], pair[1]],
        outputs: [bundles[0].output, bundles[1].output],
        fee: 0n,
        relayer: await this.opts.cli.keyAddress(this.opts.txSource),
        noteCts: [bundles[0].noteCt, bundles[1].noteCt],
        mvkCts: [bundles[0].mvkCt, bundles[1].mvkCt],
        inputWitnesses,
        outputMvkWitnesses: [opts.mvkWitness, opts.mvkWitness],
      });
      this.cacheAppendedPoolWitnesses(poolFrontier, tr.outLeafIndices, tr.outCommitments);
      consolidationProvingMs += tr.provingMs;
      if (tr.txHash) consolidationTxs.push(tr.txHash);

      const spent = new Set(pair.map((n) => n.leafIndex));
      const outputs = bundles.map((b, idx) => ({
        kind: b.kind,
        note: b.note,
        spendSk: this.account.spendSk,
        leafIndex: tr.outLeafIndices[idx],
      }));
      working = [
        ...working.filter((n) => !spent.has(n.leafIndex)),
        ...outputs.map(({ kind: _kind, ...n }) => n),
      ];
      input =
        outputs.find((n) => n.kind === "merged" && n.note.amount >= opts.amount) ??
        this.selectNote(opts.amount, working);
    }

    if (!input) {
      throw new Error(
        `shielded balance is too fragmented to unshield ${stroopsToUsdc(opts.amount)} USDC in one operation`,
      );
    }
    const changeAmount = input.note.amount - opts.amount;
    const changeNote = newNote(changeAmount, this.account.spendPub, assetId);
    const changePlain = encodeNotePlain({ ...changeNote });
    const tvk = deriveTvk(this.account.mvkSecret, scope);
    const inputWitness = await this.spendWitnessForSelectedNote(input);
    const poolFrontier = await this.preAppendPoolFrontier().catch(() => undefined);
    const wd = await this.pool.withdraw({
      source: this.opts.txSource,
      input,
      amount: opts.amount,
      to: opts.toAddress,
      changeNote,
      changeMvkPubScalar: this.account.mvkScalar,
      changeNoteCt: seal(changePlain, this.account.viewPub).bytes,
      changeMvkCt: seal(changePlain, tvk.publicKey).bytes,
      changeMvkWitness: opts.mvkWitness,
      inputWitness,
    });
    this.cacheAppendedPoolWitnesses(poolFrontier, [wd.changeLeafIndex], [wd.changeCommitment]);
    this.record({
      type: "unshield",
      amount: opts.amount.toString(),
      counterparty: opts.toAddress,
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: wd.txHash,
    });
    return {
      txHash: wd.txHash,
      nullifier: wd.nullifier,
      provingMs: consolidationProvingMs + wd.provingMs,
      consolidationTxs: consolidationTxs.length ? consolidationTxs : undefined,
      sorobanPublics: wd.proof.sorobanPublics,
    };
  }

  // ------------------------------------------------------ disclosure -----

  /**
   * shareReceipt / disclose: derive a scoped Transaction Viewing Key from this
   * account's MVK and return it plus a reconstruct() that decrypts exactly the
   * in-scope notes from on-chain ciphertext (passive auditor disclosure).
   */
  shareReceipt(scope = DISCLOSURE_SCOPE): {
    scope: string;
    tvk: ViewingKeypair;
    reconstruct: () => Array<{ amount: bigint; recipientPk: bigint }>;
  } {
    const tvk = deriveTvk(this.account.mvkSecret, scope);
    return {
      scope,
      tvk,
      reconstruct: () =>
        this.scanner
          .auditorScan(tvk.secret)
          .map((p) => ({ amount: p.amount, recipientPk: p.recipientPk })),
    };
  }

  /** Alias used by the UX copy. */
  disclose(scope = DISCLOSURE_SCOPE) {
    return this.shareReceipt(scope);
  }

  // ------------------------------------------------ confidential payroll -----

  /**
   * Confidential payroll / invoicing: pay many recipients in one batch where
   * each payout is an independent shielded transfer, so individual amounts and
   * recipients stay hidden on-chain. The employer can later prove the TOTAL to
   * an auditor with `proveTotal()` (a ZK proof-of-sum verified on-chain) —
   * salaries private, totals provable. Payouts settle sequentially.
   */
  async payroll(opts: {
    payouts: Array<{ to: BenzoRecipient; amount: bigint; memo?: string }>;
    scope?: string;
    useRelayer?: boolean;
  }): Promise<Array<{ to: BenzoRecipient; amount: bigint; txHash?: string }>> {
    const results: Array<{ to: BenzoRecipient; amount: bigint; txHash?: string }> = [];
    for (const p of opts.payouts) {
      const r = await this.send({
        amount: p.amount,
        to: p.to,
        memo: p.memo,
        useRelayer: opts.useRelayer,
        scope: opts.scope,
      }).settled();
      results.push({ to: p.to, amount: p.amount, txHash: r?.txHash });
    }
    return results;
  }

  /**
   * @deprecated NOT zero-knowledge — this sums the in-scope notes in the clear
   * and asks the auditor to trust the figure (no proof). Use {@link proveTotal},
   * which produces a `proof_of_sum` Groth16 proof that verifies on-chain (vk_id
   * `SUM`). Kept only for debugging / back-compat; do not surface it as "the"
   * disclose-total feature. The CLI `disclose-total` command uses `proveTotal`.
   */
  disclosedTotal(scope = DISCLOSURE_SCOPE): { total: bigint; count: number } {
    const notes = this.shareReceipt(scope).reconstruct();
    return { total: notes.reduce((s, n) => s + n.amount, 0n), count: notes.length };
  }

  // ----------------------------------------------------- proof-of-balance ----

  /**
   * Prove this account owns at least `minAmount` USDC in the shielded pool —
   * without revealing the exact balance, the note count, or which notes. Returns
   * the proof in both snarkjs and Soroban-encoded forms (ready for the on-chain
   * verifier) plus the public inputs. Requires `circuits.proofOfBalance`.
   */
  async proveBalance(opts: { minAmount: bigint; context?: bigint }): Promise<{
    proof: ProveResult["proof"];
    publicSignals: string[];
    sorobanProof: ProveResult["sorobanProof"];
    sorobanPublics: string[];
    root: bigint;
    threshold: bigint;
  }> {
    if (!this.opts.circuits.proofOfBalance) {
      throw new Error("proof-of-balance circuit not configured");
    }
    await this.sync();
    const assetId = await this.assetId();
    const candidates = this.spendableNotes().map((s) => ({
      amount: s.note.amount,
      blinding: s.note.blinding,
      leafIndex: s.leafIndex,
    }));
    const chosen = selectNotesForBalance(candidates, opts.minAmount);
    if (!chosen) throw new Error("insufficient shielded balance to prove this threshold");
    const root = this.pool.poolTree.root();
    const res = await generateBalanceProof({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.proofOfBalance,
      spendSk: this.account.spendSk,
      assetId,
      threshold: opts.minAmount,
      root,
      tree: this.pool.poolTree,
      notes: chosen,
      context: opts.context,
    });
    return {
      proof: res.proof,
      publicSignals: res.publicSignals,
      sorobanProof: res.sorobanProof,
      sorobanPublics: res.sorobanPublics,
      root,
      threshold: opts.minAmount,
    };
  }

  /**
   * Verify an already-generated Groth16 proof ON-CHAIN, with a DIAGNOSABLE result.
   *
   * The old version collapsed three very different outcomes into a single bare
   * `false`: (1) the VK isn't registered on this cluster (`vk-unregistered`),
   * (2) the proof is genuinely invalid (`invalid-proof` — the verifier traps
   * `InvalidProof` and fails closed), and (3) a transport/RPC failure
   * (`rpc-error`). Conflating them made a real, valid proof against an
   * unregistered VK read as "verified then false" — i.e. ZK theater. We now
   * pre-check `has_vk` and classify the trap so the caller (and the logs) can
   * tell a missing key from a bad proof from a flaky RPC.
   */
  async verifyProofOnChainDetailed(
    vkId: string,
    sorobanProof: ProveResult["sorobanProof"],
    sorobanPublics: string[],
  ): Promise<{ ok: boolean; reason: "verified" | "vk-unregistered" | "invalid-proof" | "rpc-error"; detail?: string }> {
    // Pre-check the VK exists, so an unregistered key can never masquerade as a
    // verified-then-false result.
    try {
      const present = await this.opts.cli.view(this.opts.deployment.verifier, this.opts.txSource, [
        "has_vk",
        "--vk_id",
        vkId,
      ]);
      if (present !== true) {
        return { ok: false, reason: "vk-unregistered", detail: `VK '${vkId}' is not registered on verifier ${this.opts.deployment.verifier}` };
      }
    } catch (e) {
      return { ok: false, reason: "rpc-error", detail: `has_vk('${vkId}') failed: ${String(e)}` };
    }
    try {
      const r = await this.opts.cli.view(this.opts.deployment.verifier, this.opts.txSource, [
        "verify_proof",
        "--vk_id",
        vkId,
        "--proof",
        JSON.stringify(sorobanProof),
        "--public_inputs",
        JSON.stringify(sorobanPublics),
      ]);
      if (r === true) return { ok: true, reason: "verified" };
      return { ok: false, reason: "invalid-proof", detail: `verify_proof returned ${JSON.stringify(r)}` };
    } catch (e) {
      const msg = String(e);
      // The verifier traps Error::InvalidProof (#4) on a genuinely-bad proof;
      // anything else (timeout, transport, host error) is an RPC-class failure.
      const reason = /InvalidProof|Contract,\s*#4|#4\b/.test(msg) ? "invalid-proof" : "rpc-error";
      if (reason === "rpc-error") console.warn(`verifyProofOnChain('${vkId}'): RPC error: ${msg}`);
      return { ok: false, reason, detail: msg };
    }
  }

  /**
   * Boolean convenience over {@link verifyProofOnChainDetailed}: true iff the
   * on-chain pairing check passes. Unlike the old bare-catch version, a `false`
   * here is logged with its classified reason rather than swallowed silently.
   */
  async verifyProofOnChain(
    vkId: string,
    sorobanProof: ProveResult["sorobanProof"],
    sorobanPublics: string[],
  ): Promise<boolean> {
    const r = await this.verifyProofOnChainDetailed(vkId, sorobanProof, sorobanPublics);
    if (!r.ok) {
      console.warn(`verifyProofOnChain('${vkId}') -> false [${r.reason}]${r.detail ? ": " + r.detail : ""}`);
    }
    return r.ok;
  }

  /**
   * Prove this account's shielded holdings sum to an EXACT total — the
   * confidential disclose-total, a cryptographic replacement for the plaintext
   * `disclosedTotal`. Reveals only the total, never any individual amount.
   * Requires `circuits.proofOfSum`. Aggregates up to 4 notes (circuit-fixed).
   *
   * Completeness note: this proves "these owned notes sum to `total`", not
   * "these are ALL my notes" — set-completeness composes with the authorized-MVK
   * registry binding.
   */
  async proveTotal(opts?: { context?: bigint }): Promise<{
    proof: ProveResult["proof"];
    publicSignals: string[];
    sorobanProof: ProveResult["sorobanProof"];
    sorobanPublics: string[];
    root: bigint;
    total: bigint;
  }> {
    if (!this.opts.circuits.proofOfSum) {
      throw new Error("proof-of-sum circuit not configured");
    }
    await this.sync();
    const assetId = await this.assetId();
    const candidates = this.spendableNotes()
      .slice(0, MAX_SUM_NOTES)
      .map((s) => ({ amount: s.note.amount, blinding: s.note.blinding, leafIndex: s.leafIndex }));
    if (candidates.length === 0) throw new Error("no shielded notes to total");
    const total = candidates.reduce((sm, n) => sm + n.amount, 0n);
    const root = this.pool.poolTree.root();
    const res = await generateSumProof({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.proofOfSum,
      spendSk: this.account.spendSk,
      assetId,
      claimedTotal: total,
      root,
      tree: this.pool.poolTree,
      notes: candidates,
      context: opts?.context,
    });
    return {
      proof: res.proof,
      publicSignals: res.publicSignals,
      sorobanProof: res.sorobanProof,
      sorobanPublics: res.sorobanPublics,
      root,
      total,
    };
  }

  /**
   * ORG proof-of-sum — disclose the M-of-N TREASURY total to an auditor as a real
   * Groth16 proof verified ON-CHAIN (vk_id ORGSUM), revealing only the total, not
   * any individual salary. Unlike `proveTotal` (single-key notes), this proves the
   * sum over ORG notes owned by the member set. Aggregates up to MAX_SUM_NOTES.
   */
  async proveOrgTotal(opts: { org: OrgIdentity; context?: bigint }): Promise<{
    proof: ProveResult["proof"];
    publicSignals: string[];
    sorobanProof: ProveResult["sorobanProof"];
    sorobanPublics: string[];
    root: bigint;
    total: bigint;
    onChain: boolean;
  }> {
    if (!this.opts.circuits.proofOfSumOrg) {
      throw new Error("org proof-of-sum circuit not configured");
    }
    await this.sync();
    const assetId = await this.assetId();
    const notes = this.orgTreasuryNotes(opts.org).slice(0, MAX_SUM_NOTES);
    if (notes.length === 0) throw new Error("no org treasury notes to total");
    const total = notes.reduce((s, n) => s + n.note.amount, 0n);
    const root = this.pool.poolTree.root();
    const res = await generateSumProofOrg({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.proofOfSumOrg,
      orgMemberRoot: opts.org.memberRoot,
      threshold: opts.org.threshold,
      akGroup: opts.org.akGroup,
      assetId,
      claimedTotal: total,
      root,
      tree: this.pool.poolTree,
      notes: notes.map((n) => ({ amount: n.note.amount, blinding: n.note.blinding, leafIndex: n.leafIndex })),
      context: opts.context ?? 0n,
    });
    const onChain = await this.verifyProofOnChain("ORGSUM", res.sorobanProof, res.sorobanPublics);
    return {
      proof: res.proof,
      publicSignals: res.publicSignals,
      sorobanProof: res.sorobanProof,
      sorobanPublics: res.sorobanPublics,
      root,
      total,
      onChain,
    };
  }

  /**
   * ORG proof-of-balance — prove the M-of-N treasury holds AT LEAST `minTotal`,
   * verified ON-CHAIN (vk_id ORGBAL), revealing nothing else. Powers the cryptographic
   * "Payroll funded ✓" (minTotal = run total), reserves-to-lender (covenant), and
   * true solvency (minTotal = Σ liabilities). Returns `{ holds, onChain }` —
   * `holds:false` (no proof) when the treasury can't cover the floor.
   */
  async proveOrgBalance(opts: { org: OrgIdentity; minTotal: bigint; context?: bigint }): Promise<{
    holds: boolean;
    onChain: boolean;
    minTotal: bigint;
    root?: bigint;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.proofOfBalanceOrg) {
      throw new Error("org proof-of-balance circuit not configured");
    }
    await this.sync();
    const assetId = await this.assetId();
    const all = this.orgTreasuryNotes(opts.org).map((n) => ({
      amount: n.note.amount,
      blinding: n.note.blinding,
      leafIndex: n.leafIndex,
    }));
    const chosen = selectNotesForBalance(all, opts.minTotal);
    if (!chosen) return { holds: false, onChain: false, minTotal: opts.minTotal };
    const root = this.pool.poolTree.root();
    const res = await generateBalanceProofOrg({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.proofOfBalanceOrg,
      orgMemberRoot: opts.org.memberRoot,
      orgThreshold: opts.org.threshold,
      akGroup: opts.org.akGroup,
      assetId,
      minTotal: opts.minTotal,
      root,
      tree: this.pool.poolTree,
      notes: chosen,
      context: opts.context ?? 0n,
    });
    const onChain = await this.verifyProofOnChain("ORGBAL", res.sorobanProof, res.sorobanPublics);
    return { holds: true, onChain, minTotal: opts.minTotal, root, sorobanProof: res.sorobanProof, sorobanPublics: res.sorobanPublics };
  }

  /**
   * In-ZK spending policy (Z3) — prove a payout to `to` of `amount` is WITHIN the
   * approved per-payout `cap`, verified ON-CHAIN (vk_id SPENDCAP), WITHOUT
   * revealing the amount. The limit is a circuit constraint, so an over-cap payout
   * cannot produce a proof — `withinCap:false` is a cryptographic "no". Use as a
   * pre-settlement gate: a line that can't prove ≤ cap is provably blocked.
   */
  async proveOrgPayoutCap(opts: {
    to: BenzoRecipient;
    amount: bigint;
    cap: bigint;
    context?: bigint;
  }): Promise<{
    withinCap: boolean;
    onChain: boolean;
    cap: bigint;
    commitment?: bigint;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.spendingCap) {
      throw new Error("spending-cap circuit not configured");
    }
    const assetId = await this.assetId();
    const note: Note = {
      amount: opts.amount,
      recipientPk: opts.to.spendPub,
      blinding: randomFieldElement(),
      assetId,
    };
    try {
      const res = await generateSpendingCapProof({
        prover: this.opts.prover,
        artifacts: this.opts.circuits.spendingCap,
        note,
        cap: opts.cap,
        context: opts.context ?? 0n,
      });
      const onChain = await this.verifyProofOnChain("SPENDCAP", res.sorobanProof, res.sorobanPublics);
      return { withinCap: true, onChain, cap: opts.cap, commitment: res.commitment, sorobanProof: res.sorobanProof, sorobanPublics: res.sorobanPublics };
    } catch {
      // amount > cap ⇒ the `amount <= cap` constraint is unsatisfiable ⇒ no proof.
      return { withinCap: false, onChain: false, cap: opts.cap };
    }
  }

  /**
   * Per-payout proof-of-innocence (Z4) — prove a payout's RECIPIENT is NOT on a
   * sanctions / deny set (OFAC-style deny SMT), verified ON-CHAIN (vk_id
   * POIPAYOUT), WITHOUT revealing the recipient. A sanctioned recipient is found
   * in the deny SMT ⇒ no non-inclusion proof exists ⇒ `innocent:false`, the
   * payout is provably blocked.
   */
  async proveOrgPayoutInnocence(opts: {
    to: BenzoRecipient;
    amount: bigint;
    context?: bigint;
  }): Promise<{
    innocent: boolean;
    onChain: boolean;
    commitment?: bigint;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.payoutInnocence) {
      throw new Error("payout-innocence circuit not configured");
    }
    const assetId = await this.assetId();
    const recipientPk = opts.to.spendPub;
    // Non-inclusion witness for recipientPk from the on-chain deny SMT.
    const fr = (await this.opts.cli.view(this.opts.deployment.aspNonMembership, this.opts.txSource, [
      "find_key",
      "--key",
      recipientPk.toString(),
    ])) as { found: boolean; siblings: string[]; not_found_key: string; not_found_value: string; is_old0: boolean };
    if (fr.found) return { innocent: false, onChain: false }; // recipient is sanctioned
    const siblings = fr.siblings.map((s) => BigInt(s));
    while (siblings.length < this.opts.deployment.smtLevels) siblings.push(0n);
    const denyRoot = await this.pool.aspDenyRoot();
    const note: Note = { amount: opts.amount, recipientPk, blinding: randomFieldElement(), assetId };
    const res = await generatePayoutInnocenceProof({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.payoutInnocence,
      note,
      denyRoot,
      smt: { siblings, oldKey: BigInt(fr.not_found_key), oldValue: BigInt(fr.not_found_value), isOld0: fr.is_old0 ? 1n : 0n },
      context: opts.context ?? 0n,
    });
    const onChain = await this.verifyProofOnChain("POIPAYOUT", res.sorobanProof, res.sorobanPublics);
    return { innocent: true, onChain, commitment: res.commitment, sorobanProof: res.sorobanProof, sorobanPublics: res.sorobanPublics };
  }

  /**
   * Anonymous approver / surveillance-free dual-control (Z5) — prove ≥`threshold`
   * DISTINCT org approvers signed off on a run (`spendMessage`), verified ON-CHAIN
   * (vk_id ORGAUTH), WITHOUT revealing WHICH approvers signed. Dual-control
   * becomes a property of the proof; the approval leaves no surveillance trail of
   * who signed. Returns `approved:false` if fewer than `threshold` signers (the
   * count constraint is unsatisfiable, so no proof).
   */
  async proveOrgApproval(opts: {
    memberSeeds: number[];
    signerIndices: number[];
    threshold: bigint;
    spendMessage: bigint;
  }): Promise<{
    approved: boolean;
    onChain: boolean;
    approvers: number;
    threshold: bigint;
    memberCount: number;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.orgSpendAuth) {
      throw new Error("org spend-auth circuit not configured");
    }
    try {
      const res = await generateOrgApprovalProof({
        prover: this.opts.prover,
        artifacts: this.opts.circuits.orgSpendAuth,
        memberSeeds: opts.memberSeeds,
        signerIndices: opts.signerIndices,
        threshold: opts.threshold,
        spendMessage: opts.spendMessage,
      });
      const onChain = await this.verifyProofOnChain("ORGAUTH", res.sorobanProof, res.sorobanPublics);
      return {
        approved: true,
        onChain,
        approvers: res.approvers,
        threshold: opts.threshold,
        memberCount: opts.memberSeeds.length,
        sorobanProof: res.sorobanProof,
        sorobanPublics: res.sorobanPublics,
      };
    } catch {
      // fewer than threshold distinct signers ⇒ count constraint unsatisfiable ⇒ no proof.
      return { approved: false, onChain: false, approvers: opts.signerIndices.length, threshold: opts.threshold, memberCount: opts.memberSeeds.length };
    }
  }

  /**
   * Verifiable payroll computation (Z6) — prove the run total AND each per-line
   * note commitment were CORRECTLY DERIVED from the rate card (gross = rate ×
   * period − deductions, runTotal = Σ gross), verified ON-CHAIN (vk_id PAYCOMP),
   * with the RATE CARD kept PRIVATE. The total is computed-not-asserted: the chain
   * accepts it only if it equals the sum of the hidden grosses.
   */
  async proveOrgPayrollComputation(opts: {
    lines: PayrollLineInput[];
    context?: bigint;
  }): Promise<{
    ok: boolean;
    onChain: boolean;
    runTotal: bigint;
    commitDigest: bigint;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.payrollComputation) {
      throw new Error("payroll-computation circuit not configured");
    }
    const assetId = await this.assetId();
    const res = await generatePayrollComputationProof({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.payrollComputation,
      lines: opts.lines,
      assetId,
      context: opts.context ?? 0n,
    });
    const onChain = await this.verifyProofOnChain("PAYCOMP", res.sorobanProof, res.sorobanPublics);
    return { ok: true, onChain, runTotal: res.runTotal, commitDigest: res.commitDigest, sorobanProof: res.sorobanProof, sorobanPublics: res.sorobanPublics };
  }

  /**
   * KYB-as-ZK credential (Z7) — prove the org holds an issuer-signed KYB
   * credential, disclosing only "verified business, jurisdiction Y, tier Z",
   * verified ON-CHAIN (vk_id KYB), WITHOUT revealing the documents. Emits a
   * scope-bound `orgNullifier` for one-credential-per-scope Sybil resistance.
   */
  async proveOrgKyb(opts: {
    issuerSeed: number;
    holderSk: bigint;
    jurisdiction: bigint;
    tier: bigint;
    docsHash: bigint;
    expiry: bigint;
    serial: bigint;
    scope: bigint;
    currentTime: bigint;
  }): Promise<{
    ok: boolean;
    onChain: boolean;
    jurisdiction: bigint;
    tier: bigint;
    orgNullifier: bigint;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.kybCredential) {
      throw new Error("KYB credential circuit not configured");
    }
    const res = await generateKybCredentialProof({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.kybCredential,
      issuerSeed: opts.issuerSeed,
      holderSk: opts.holderSk,
      jurisdiction: opts.jurisdiction,
      tier: opts.tier,
      docsHash: opts.docsHash,
      expiry: opts.expiry,
      serial: opts.serial,
      scope: opts.scope,
      currentTime: opts.currentTime,
    });
    const onChain = await this.verifyProofOnChain("KYB", res.sorobanProof, res.sorobanPublics);
    return { ok: true, onChain, jurisdiction: res.jurisdiction, tier: res.tier, orgNullifier: res.orgNullifier, sorobanProof: res.sorobanProof, sorobanPublics: res.sorobanPublics };
  }

  /**
   * Cross-entity private netting (Z8) — prove two parties' mutual inter-company
   * invoices net to a single `net` amount (paid by the larger debtor), verified
   * ON-CHAIN (vk_id NETTING), WITHOUT revealing either gross. The two orgs settle
   * only the difference. Returns `net` + `payerIsA` (1 = A pays B, 0 = B pays A).
   */
  async proveCrossNetting(opts: {
    aOwesB: bigint;
    bOwesA: bigint;
    context?: bigint;
  }): Promise<{
    onChain: boolean;
    net: bigint;
    payerIsA: bigint;
    sorobanProof?: ProveResult["sorobanProof"];
    sorobanPublics?: string[];
  }> {
    if (!this.opts.circuits.crossNetting) {
      throw new Error("cross-netting circuit not configured");
    }
    const res = await generateCrossNettingProof({
      prover: this.opts.prover,
      artifacts: this.opts.circuits.crossNetting,
      aOwesB: opts.aOwesB,
      bOwesA: opts.bOwesA,
      context: opts.context ?? 0n,
    });
    const onChain = await this.verifyProofOnChain("NETTING", res.sorobanProof, res.sorobanPublics);
    return { onChain, net: res.net, payerIsA: res.payerIsA, sorobanProof: res.sorobanProof, sorobanPublics: res.sorobanPublics };
  }

  // --------------------------------------------------------- @handle -----

  /**
   * Register this account's public payment address under a `@handle` in the
   * on-chain registry. `ownerAddress`/`ownerSource` authorize the entry.
   */
  async registerHandle(opts: {
    handle: string;
    ownerAddress?: string;
    ownerSource?: string;
  }): Promise<{ txHash?: string }> {
    if (!this.opts.handleRegistry) throw new Error("no handle registry configured");
    const ownerSource = opts.ownerSource ?? this.opts.txSource;
    const ownerAddress = opts.ownerAddress ?? (await this.opts.cli.keyAddress(ownerSource));
    const res = await this.opts.cli.invoke({
      contractId: this.opts.handleRegistry,
      source: ownerSource,
      send: true,
      fnArgs: [
        "register",
        "--handle", opts.handle,
        "--owner", ownerAddress,
        "--spend_pub", feHex32(this.account.spendPub),
        "--view_pub", bytesHex(this.account.viewPub),
        "--mvk_scalar", feHex32(this.account.mvkScalar),
      ],
    });
    return { txHash: res.txHash };
  }

  /** Resolve a `@handle` to a sendable recipient address. */
  async resolveHandle(handle: string): Promise<BenzoRecipient> {
    if (!this.opts.handleRegistry) throw new Error("no handle registry configured");
    const rec = (await this.opts.cli.view(this.opts.handleRegistry, this.opts.txSource, [
      "resolve",
      "--handle",
      handle,
    ])) as { spend_pub: string; view_pub: string; mvk_scalar: string };
    return {
      spendPub: BigInt("0x" + rec.spend_pub),
      viewPub: fromHex(rec.view_pub),
      mvkScalar: BigInt("0x" + rec.mvk_scalar),
      label: handle,
    };
  }

  /** Resolve a `@handle` and send to it. Returns the SendHandle. */
  async sendToHandle(opts: {
    handle: string;
    amount: bigint;
    memo?: string;
    useRelayer?: boolean;
    mvkWitness?: AspMembershipWitness;
  }): Promise<SendHandle> {
    const to = await this.resolveHandle(opts.handle);
    return this.send({ amount: opts.amount, to, memo: opts.memo, useRelayer: opts.useRelayer, mvkWitness: opts.mvkWitness });
  }

  // ----------------------------------------------------- claim-links -----

  /**
   * Create a claim link: privately send `amount` to a fresh account derived
   * from a random claim secret, and return a link carrying that secret. Anyone
   * with the link can claim the funds — no prior account or on-chain state.
   */
  async createClaimLink(opts: {
    amount: bigint;
    useRelayer?: boolean;
    mvkWitness?: AspMembershipWitness;
  }): Promise<{ link: string; claimSecretHex: string; sendTx?: string; recipient: BenzoRecipient; sorobanPublics: string[] }> {
    const secret = new Uint8Array(randomBytes(32));
    const claimAccount = accountFromClaimSecret(secret);
    const to = paymentAddress(claimAccount);
    const handle = this.send({ amount: opts.amount, to, memo: "claim-link", useRelayer: opts.useRelayer, mvkWitness: opts.mvkWitness });
    const r = await handle.settled();
    const link = `benzo://claim#${toBase64Url(secret)}`;
    return { link, claimSecretHex: toHex(secret), sendTx: r?.txHash, recipient: to, sorobanPublics: r?.sorobanPublics ?? [] };
  }

  /** Parse a claim link into its claim secret. */
  static parseClaimLink(link: string): Uint8Array {
    const frag = link.split("#")[1];
    if (!frag) throw new Error("invalid claim link");
    return fromBase64Url(frag);
  }

  /**
   * Claim a link's funds into a public Stellar address. This client ADOPTS the
   * claim account (derived from the secret), scans, and unshields the full
   * balance to `toAddress` — settling the claim on-chain.
   */
  async claim(opts: {
    claimSecret: Uint8Array;
    toAddress: string;
    mvkWitness?: AspMembershipWitness;
  }): Promise<{ txHash?: string; amount: bigint; sorobanPublics: string[] }> {
    this.useAccount(accountFromClaimSecret(opts.claimSecret));
    await this.syncForSpend();
    // withdraw is 1-input, so a claim account with several notes is claimed one
    // note at a time (a claim link usually holds a single note).
    let amount = 0n;
    let lastTx: string | undefined;
    const sorobanPublics: string[] = [];
    for (;;) {
      // Skip 0-value change notes left behind by a full-note withdraw.
      const notes = this.spendableNotes().filter((n) => n.note.amount > 0n);
      if (notes.length === 0) break;
      const wd = await this.unshield({ amount: notes[0].note.amount, toAddress: opts.toAddress, mvkWitness: opts.mvkWitness });
      amount += notes[0].note.amount;
      lastTx = wd.txHash;
      sorobanPublics.push(...wd.sorobanPublics);
      await this.syncForSpend(); // refresh the spent-set before the next note
    }
    if (amount === 0n) throw new Error("nothing to claim (already claimed or unfunded)");
    return { txHash: lastTx, amount, sorobanPublics };
  }

  // ------------------------------------------------ requests / invoices --

  /**
   * Create a payment request / invoice (the pull primitive). Returns a shareable
   * benzo://request link; `register: true` also opens it on-chain in the
   * request_registry so its status is trackable. No funds are escrowed. Amounts
   * are base units (stroops); omit `amount` for a variable/donation request.
   */
  async createRequest(opts: {
    to: string; // requester @handle (or address) to be paid
    amount?: bigint;
    minAmount?: bigint;
    expiry: number; // unix seconds
    memo?: string;
    reference?: string;
    payer?: string; // bound request (omit = open invoice)
    register?: boolean; // also anchor on-chain
    payeeSource?: string; // CLI identity authorizing register (defaults txSource)
  }): Promise<{ link: string; id: string }> {
    const id = randomFieldElement().toString();
    const link = encodeBenzoLink({
      type: "request",
      to: opts.to,
      id,
      amount: opts.amount !== undefined ? opts.amount.toString() : undefined,
      asset: "USDC",
      memo: opts.memo,
      expiry: String(opts.expiry),
      reference: opts.reference,
      payer: opts.payer,
    });
    if (opts.register) {
      if (!this.opts.requestRegistry) throw new Error("no request registry configured");
      const source = opts.payeeSource ?? this.opts.txSource;
      const payeeAddr = await this.opts.cli.keyAddress(source);
      await this.opts.cli.invoke({
        contractId: this.opts.requestRegistry,
        source,
        send: true,
        fnArgs: [
          "register",
          "--payee", payeeAddr,
          "--commitment", id,
          "--amount", (opts.amount ?? 0n).toString(),
          "--min_amount", (opts.minAmount ?? 0n).toString(),
          "--expiry", String(opts.expiry),
        ],
      });
    }
    return { link, id };
  }

  /**
   * Fulfill a request: a private send to the requester carrying the request id
   * in the (encrypted) memo so they can correlate. Returns the burned input
   * nullifier so the requester can `markRequestPaid` against a real payment.
   */
  async payRequest(
    link: string,
    opts?: { amount?: bigint },
  ): Promise<{ txHash?: string; nullifier: bigint; id?: string; amount: bigint }> {
    const parsed = parseBenzoLink(link);
    if (!parsed || parsed.type !== "request") throw new Error("not a benzo request link");
    const amount = opts?.amount ?? (parsed.amount ? BigInt(parsed.amount) : undefined);
    if (amount === undefined) throw new Error("amount required for a variable request");
    const handle = parsed.to.replace(/^@/, "");
    const memo = parsed.id ? `req:${parsed.id}` : parsed.memo;
    const h = await this.sendToHandle({ handle, amount, memo });
    const r = await h.settled();
    return { txHash: r?.txHash, nullifier: r?.nullifier ?? 0n, id: parsed.id, amount };
  }

  /** Mark a request (partly) paid on-chain, bound to a real payment nullifier. */
  async markRequestPaid(opts: {
    id: string;
    nullifier: bigint;
    amount: bigint;
    payeeSource?: string;
  }): Promise<void> {
    if (!this.opts.requestRegistry) throw new Error("no request registry configured");
    await this.opts.cli.invoke({
      contractId: this.opts.requestRegistry,
      source: opts.payeeSource ?? this.opts.txSource,
      send: true,
      fnArgs: [
        "mark_paid",
        "--commitment", opts.id,
        "--nullifier", opts.nullifier.toString(),
        "--paid_amount", opts.amount.toString(),
      ],
    });
  }

  /** Read a request's on-chain status. Returns null if not registered. */
  async getRequest(id: string): Promise<{
    status: string;
    amount: bigint;
    minAmount: bigint;
    paidTotal: bigint;
    expiry: number;
  } | null> {
    if (!this.opts.requestRegistry) throw new Error("no request registry configured");
    const v = await this.opts.cli.view(this.opts.requestRegistry, this.opts.txSource, [
      "get",
      "--commitment",
      id,
    ]);
    if (v == null) return null;
    const r = v as Record<string, unknown>;
    const status = r.status as { tag?: string } | string | undefined;
    const statusTag = Array.isArray(status)
      ? String(status[0] ?? "")
      : typeof status === "object"
        ? String(status?.tag ?? "")
        : String(status);
    return {
      status: statusTag,
      amount: BigInt(String(r.amount ?? 0)),
      minAmount: BigInt(String(r.min_amount ?? 0)),
      paidTotal: BigInt(String(r.paid_total ?? 0)),
      expiry: Number(r.expiry ?? 0),
    };
  }

  /** Requester-only cancel of an open request. */
  async cancelRequest(id: string, payeeSource?: string): Promise<void> {
    if (!this.opts.requestRegistry) throw new Error("no request registry configured");
    await this.opts.cli.invoke({
      contractId: this.opts.requestRegistry,
      source: payeeSource ?? this.opts.txSource,
      send: true,
      fnArgs: ["cancel", "--commitment", id],
    });
  }

  /** Permissionless close of an expired request. */
  async expireRequest(id: string): Promise<void> {
    if (!this.opts.requestRegistry) throw new Error("no request registry configured");
    await this.opts.cli.invoke({
      contractId: this.opts.requestRegistry,
      source: this.opts.txSource,
      send: true,
      fnArgs: ["expire", "--commitment", id],
    });
  }

  // ----------------------------------------------------- cashIn/cashOut --

  /** cashIn: SEP-24 deposit (anchor settles USDC to this account) then shield. */
  async cashIn(opts: { amount: bigint; fromSource: string }): Promise<{
    fiatInTx?: string;
    shieldTx?: string;
    leafIndex: number;
  }> {
    if (!this.opts.anchor) throw new Error("no anchor configured");
    if (!this.account.stellarAddress || !this.account.stellarSecret)
      throw new Error("account has no Stellar identity for the public edge");
    const human = stroopsToUsdc(opts.amount);
    const jwt = await this.opts.anchor.authenticate(this.account.stellarSecret);
    const dep = await this.opts.anchor.startDeposit(jwt, this.account.stellarAddress, human);
    const settled = await this.opts.anchor.sim(jwt, dep.id, { amount: human });
    const sh = await this.shield({
      amount: opts.amount,
      fromAddress: this.account.stellarAddress,
      fromSource: opts.fromSource,
    });
    this.record({
      type: "cashIn",
      amount: opts.amount.toString(),
      counterparty: "anchor (fiat SIMULATED)",
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: settled.stellar_transaction_id,
    });
    return { fiatInTx: settled.stellar_transaction_id, shieldTx: sh.txHash, leafIndex: sh.leafIndex };
  }

  /** cashOut: unshield to this account's public address, then SEP-24 withdraw. */
  async cashOut(opts: { amount: bigint }): Promise<{ unshieldTx?: string; fiatOutTx?: string }> {
    if (!this.opts.anchor) throw new Error("no anchor configured");
    if (!this.account.stellarAddress || !this.account.stellarSecret)
      throw new Error("account has no Stellar identity for the public edge");
    const human = stroopsToUsdc(opts.amount);
    const wd = await this.unshield({ amount: opts.amount, toAddress: this.account.stellarAddress });
    const jwt = await this.opts.anchor.authenticate(this.account.stellarSecret);
    const w = await this.opts.anchor.startWithdraw(jwt, this.account.stellarAddress, human);
    if (!w.withdraw_anchor_account || !w.withdraw_memo) {
      throw new Error("anchor withdraw response missing destination account or memo");
    }
    const payHash = await this.opts.anchor.sendUsdcToAnchor(
      this.account.stellarSecret,
      w.withdraw_anchor_account,
      human,
      w.withdraw_memo,
    );
    await this.opts.anchor.sim(jwt, w.id, { stellar_transaction_id: payHash, amount: human });
    this.record({
      type: "cashOut",
      amount: opts.amount.toString(),
      counterparty: "anchor (fiat SIMULATED)",
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: payHash,
    });
    return { unshieldTx: wd.txHash, fiatOutTx: payHash };
  }
}

/** stroops (7dp) -> human USDC string. */
export function stroopsToUsdc(stroops: bigint): string {
  const neg = stroops < 0n;
  const s = (neg ? -stroops : stroops).toString().padStart(8, "0");
  const whole = s.slice(0, -7) || "0";
  const frac = s.slice(-7);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * Parse a human USDC amount ("25", "25.50", "0.0000001") to stroops (1 USDC =
 * 1e7), losslessly via string math — unlike `BigInt(Math.round(n * 1e7))`,
 * which loses precision past ~9e9 USDC or beyond 7 decimals.
 */
export function usdcToStroops(amount: string): bigint {
  const neg = amount.trim().startsWith("-");
  const [whole, frac = ""] = amount.trim().replace(/^[-+]/, "").split(".");
  if (frac.length > 7) throw new Error("USDC has at most 7 decimals");
  const stroops = BigInt(whole || "0") * 10_000_000n + BigInt(frac.padEnd(7, "0") || "0");
  return neg ? -stroops : stroops;
}

export { decodeNotePlain, noteNullifier, noteCommitment, deriveKeypair, mvkTag, open, viewingPubToScalar };
