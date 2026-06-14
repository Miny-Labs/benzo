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
  type ScannerSnapshot,
  type AspSnapshot,
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
import { proveBalance as generateBalanceProof, selectNotesForBalance } from "./balance.js";
import { transferRelayFnArgs } from "./relay.js";
import type { ProveResult, ProverPort } from "./prover.js";
import { encodeBenzoLink, parseBenzoLink } from "@benzo/links";
import { randomBytes } from "./crypto/random.js";

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
  result?: { txHash?: string; amount: bigint; recipient?: string; provingMs?: number; nullifier?: bigint };
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
  /** CLI identity that pays gas + ASP curation + read simulations */
  txSource: string;
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

export class BenzoClient {
  readonly pool: BenzoPoolClient;
  scanner: NoteScanner;
  account!: BenzoAccount;
  private journal: HistoryItem[] = [];
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
  async sync(): Promise<void> {
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
    const poolFrom = this.scanner.cursorLedger > 0 ? this.scanner.cursorLedger + 1 : 1;
    await syncFromRpc(this.scanner, rpcUrl, [deployment.pool, deployment.viewkeyAnchor], poolFrom);
    await store.set(this.key("scan"), JSON.stringify(this.scanner.snapshot()));
    this.pool.poolRebuild(this.scanner.orderedLeaves());

    // ASP allow-set: same incremental, persisted resume.
    const aspFrom = this.aspCursor > 0 ? this.aspCursor + 1 : 1;
    const asp = await fetchAspLeavesSince(rpcUrl, deployment.aspMembership, aspFrom, this.aspLeaves);
    this.aspLeaves = asp.leaves;
    this.aspCursor = asp.cursor;
    const aspSnap: AspSnapshot = {
      v: 1,
      cursorLedger: this.aspCursor,
      leaves: this.aspLeaves.map(String),
    };
    await store.set(this.key("asp"), JSON.stringify(aspSnap));
    this.pool.aspRebuild(this.aspLeaves);
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

  /** Load persisted scanner snapshot, ASP set, and journal once per account. */
  private async loadStateOnce(): Promise<void> {
    const { store, deployment } = this.opts;
    if (!store || this.stateLoaded) return;
    const scanRaw = await store.get(this.key("scan"));
    this.scanner = scanRaw
      ? NoteScanner.restore(deployment.treeLevels, JSON.parse(scanRaw) as ScannerSnapshot)
      : new NoteScanner(deployment.treeLevels, 1);
    const aspRaw = await store.get(this.key("asp"));
    if (aspRaw) {
      const snap = JSON.parse(aspRaw) as AspSnapshot;
      this.aspLeaves = snap.leaves.map((s) => BigInt(s));
      this.aspCursor = snap.cursorLedger;
    }
    const journalRaw = await store.get(this.key("journal"));
    if (journalRaw) this.journal = JSON.parse(journalRaw) as HistoryItem[];
    this.stateLoaded = true;
  }

  /** Await all pending durable writes (call before process exit). */
  async flush(): Promise<void> {
    await this.persistChain;
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

  /**
   * Typed transaction history: the local journal (self-initiated ops with
   * counterparties) reconciled with on-chain receives discovered by scanning.
   */
  getHistory(): HistoryItem[] {
    const items: HistoryItem[] = [...this.journal];

    // Incoming notes this account can decrypt that aren't journal entries.
    const journaledTx = new Set(this.journal.map((j) => j.txHash).filter(Boolean));
    for (const d of this.scanner.scan(this.account.viewSecret)) {
      const rec = this.scanner.commitments[d.leafIndex];
      if (!rec || journaledTx.has(rec.txHash)) continue;
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

  private record(item: HistoryItem): void {
    this.journal.push(item);
    const store = this.opts.store;
    if (store) {
      // Snapshot now; serialize writes through the persist chain (no races).
      const snapshot = JSON.stringify(this.journal);
      this.persistChain = this.persistChain
        .then(() => store.set(this.key("journal"), snapshot))
        .catch(() => {});
    }
  }

  // ------------------------------------------------------------ shield ----

  /**
   * Shield public USDC into a note owned by this account. Ensures the
   * depositor address is ASP-allowlisted (curator op) first.
   */
  async shield(opts: {
    amount: bigint;
    fromAddress: string; // public depositor G-address (must auth the SAC pull)
    fromSource: string; // CLI identity authorizing the deposit
    scope?: string; // disclosure scope to seal the MVK ciphertext under
  }): Promise<{ txHash?: string; leafIndex: number; commitment: bigint; note: Note; provingMs: number }> {
    await this.sync();
    const assetId = await this.assetId();

    // ASP allow-membership (regulated edge): curator inserts the depositor.
    const aspBlinding = randomFieldElement();
    const depositorScalar = await this.pool.depositorScalar(opts.fromAddress);
    const leaf = aspLeaf(depositorScalar, aspBlinding);
    await this.opts.cli.invoke({
      contractId: this.opts.deployment.aspMembership,
      source: this.opts.txSource,
      send: true,
      fnArgs: ["insert_leaf", "--leaf", leaf.toString()],
    });
    const aspLeafIndex = this.pool.aspMirrorInsert(leaf);

    const note = newNote(opts.amount, this.account.spendPub, assetId);
    const plain = encodeNotePlain({ ...note });
    const tvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
    const res = await this.pool.shield({
      source: opts.fromSource,
      from: opts.fromAddress,
      note,
      mvkPubScalar: this.account.mvkScalar,
      aspBlinding,
      aspLeafIndex,
      noteCt: seal(plain, this.account.viewPub).bytes,
      mvkCt: seal(plain, tvk.publicKey).bytes,
    });
    this.record({
      type: "shield",
      amount: opts.amount.toString(),
      counterparty: opts.fromAddress,
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: res.txHash,
    });
    return { txHash: res.txHash, leafIndex: res.leafIndex, commitment: res.commitment, note, provingMs: res.provingMs };
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
  }): SendHandle {
    const handle = new SendHandle(`send-${++opCounter}`);
    // Kick off async work without blocking the caller (optimistic UI).
    void this.runSend(handle, opts);
    return handle;
  }

  private async runSend(
    handle: SendHandle,
    opts: { amount: bigint; to: BenzoRecipient; memo?: string; useRelayer?: boolean; scope?: string },
  ): Promise<void> {
    try {
      handle._emit({ op: "send", status: "pending", detail: "selecting note" });
      await this.sync();
      const assetId = await this.assetId();

      // Spend one covering note (+ a dummy), or two notes when no single note
      // covers the amount — the joinsplit circuit takes two inputs either way.
      const selected = selectSpendNotes(this.spendableNotes(), opts.amount);
      if (selected.length === 0) throw new Error("insufficient spendable balance");
      const totalIn = selected.reduce((s, n) => s + n.note.amount, 0n);
      const change = totalIn - opts.amount;
      const inputs: [SpendableNote, SpendableNote] =
        selected.length === 2
          ? [selected[0], selected[1]]
          : [selected[0], this.pool.makeDummyInput(assetId)];

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
      const tr = await this.pool.transfer({
        source: this.opts.relayer && opts.useRelayer ? this.opts.relayer.source : this.opts.txSource,
        relay,
        inputs,
        outputs: [b0.output, b1.output],
        fee: 0n,
        relayer: this.opts.relayer?.address ?? (await this.opts.cli.keyAddress(this.opts.txSource)),
        noteCts: [b0.noteCt, b1.noteCt],
        mvkCts: [b0.mvkCt, b1.mvkCt],
      });

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
      handle._resolve({ txHash: tr.txHash, amount: opts.amount, recipient: opts.to.label, provingMs: tr.provingMs, nullifier: tr.nullifiers[0] });
    } catch (e) {
      handle._emit({ op: "send", status: "failed", detail: (e as Error).message });
      handle._reject(e as Error);
    }
  }

  /** Pick the smallest single note that covers `amount` (simple coin select). */
  private selectNote(amount: bigint): SpendableNote | null {
    const notes = this.spendableNotes()
      .filter((n) => n.note.amount >= amount)
      .sort((a, b) => (a.note.amount < b.note.amount ? -1 : 1));
    return notes[0] ?? null;
  }

  private makeRelay() {
    const { relayer, deployment, cli } = this.opts;
    if (!relayer) return undefined;
    return async (a: {
      pool: string; root: string; nullifier0: string; nullifier1: string;
      outCommitment0: string; outCommitment1: string; fee: string; relayerAddress: string;
      mvkTag0: string; mvkTag1: string; noteCt0: string; noteCt1: string;
      mvkCt0: string; mvkCt1: string; proof: string;
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
  }): Promise<{ txHash?: string; nullifier: bigint; provingMs: number }> {
    await this.sync();
    const assetId = await this.assetId();
    const input = this.selectNote(opts.amount);
    if (!input) throw new Error("insufficient spendable balance");
    const changeAmount = input.note.amount - opts.amount;
    const changeNote = newNote(changeAmount, this.account.spendPub, assetId);
    const changePlain = encodeNotePlain({ ...changeNote });
    const tvk = deriveTvk(this.account.mvkSecret, opts.scope ?? DISCLOSURE_SCOPE);
    const wd = await this.pool.withdraw({
      source: this.opts.txSource,
      input,
      amount: opts.amount,
      to: opts.toAddress,
      changeNote,
      changeMvkPubScalar: this.account.mvkScalar,
      changeNoteCt: seal(changePlain, this.account.viewPub).bytes,
      changeMvkCt: seal(changePlain, tvk.publicKey).bytes,
    });
    this.record({
      type: "unshield",
      amount: opts.amount.toString(),
      counterparty: opts.toAddress,
      timestamp: Math.floor(Date.now() / 1000),
      status: "settled",
      txHash: wd.txHash,
    });
    return { txHash: wd.txHash, nullifier: wd.nullifier, provingMs: wd.provingMs };
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
   * an auditor with `disclosedTotal()` under the same scope — salaries private,
   * totals provable. Payouts settle sequentially (each consumes notes).
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
   * Auditor-facing total: the count + summed amount of the in-scope notes a
   * scoped TVK reconstructs — lets an employer prove payroll/invoice totals
   * without revealing any individual amount. Pairs with `payroll(scope)`.
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
  }): Promise<SendHandle> {
    const to = await this.resolveHandle(opts.handle);
    return this.send({ amount: opts.amount, to, memo: opts.memo, useRelayer: opts.useRelayer });
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
  }): Promise<{ link: string; claimSecretHex: string; sendTx?: string; recipient: BenzoRecipient }> {
    const secret = new Uint8Array(randomBytes(32));
    const claimAccount = accountFromClaimSecret(secret);
    const to = paymentAddress(claimAccount);
    const handle = this.send({ amount: opts.amount, to, memo: "claim-link", useRelayer: opts.useRelayer });
    const r = await handle.settled();
    const link = `benzo://claim#${toBase64Url(secret)}`;
    return { link, claimSecretHex: toHex(secret), sendTx: r?.txHash, recipient: to };
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
  }): Promise<{ txHash?: string; amount: bigint }> {
    this.useAccount(accountFromClaimSecret(opts.claimSecret));
    await this.sync();
    const amount = await this.getBalance();
    if (amount === 0n) throw new Error("nothing to claim (already claimed or unfunded)");
    const wd = await this.unshield({ amount, toAddress: opts.toAddress });
    return { txHash: wd.txHash, amount };
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
    return {
      status: typeof status === "object" ? String(status?.tag) : String(status),
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
    const payHash = await this.opts.anchor.sendUsdcToAnchor(
      this.account.stellarSecret,
      w.withdraw_anchor_account!,
      human,
      w.withdraw_memo!,
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

export { decodeNotePlain, noteNullifier, noteCommitment, deriveKeypair, mvkTag, open, viewingPubToScalar };
