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

import {
  BenzoPoolClient,
  type BenzoDeployment,
  type CircuitSet,
  type SpendableNote,
} from "./pool.js";
import { NoteScanner, syncFromRpc, fetchAspLeaves } from "./scanner.js";
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
  createOrLoadAccountFile,
} from "./account.js";
import type { StellarCli } from "./stellar.js";
import { feHex } from "./crypto/groth16.js";
import { randomBytes } from "node:crypto";

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
  result?: { txHash?: string; amount: bigint; recipient?: string; provingMs?: number };
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
  cli: StellarCli;
  deployment: BenzoDeployment;
  circuits: CircuitSet;
  rpcUrl: string;
  /** CLI identity that pays gas + ASP curation + read simulations */
  txSource: string;
  /** optional gasless relay (relayer pays XLM, takes USDC fee) */
  relayer?: { source: string; address: string };
  /** optional anchor for cashIn/cashOut */
  anchor?: AnchorPort;
  /** optional on-chain @handle registry */
  handleRegistry?: string;
}

/** 32-byte big-endian hex of a field element (guarded; for the registry record). */
const feHex32 = feHex;
function bytesHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

const FEE_SCOPE = "default";
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
    this.pool = new BenzoPoolClient(opts.cli, opts.deployment, opts.circuits, opts.txSource);
    this.scanner = new NoteScanner(opts.deployment.treeLevels, 1);
  }

  // ----------------------------------------------------------- account ----

  /** Create a fresh in-memory account (no file). */
  createAccount(label?: string, stellarSecret?: string): BenzoAccount {
    this.account = createAccount({ label, stellarSecret });
    return this.account;
  }

  /** Load the account file at `path`, or create + persist a fresh one. */
  createOrLoadAccount(
    path: string,
    opts: { label?: string; stellarSecret?: string } = {},
  ): { account: BenzoAccount; created: boolean } {
    const r = createOrLoadAccountFile(path, opts);
    this.account = r.account;
    return r;
  }

  /** Adopt an externally constructed account (e.g. derived from a claim secret). */
  useAccount(account: BenzoAccount): void {
    this.account = account;
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

  /** Rebuild the scanner + Merkle/ASP mirrors from on-chain events. */
  async sync(): Promise<void> {
    const { rpcUrl, deployment } = this.opts;
    this.scanner = new NoteScanner(deployment.treeLevels, 1);
    await syncFromRpc(this.scanner, rpcUrl, [deployment.pool, deployment.viewkeyAnchor], 1);
    this.pool.poolRebuild(this.scanner.orderedLeaves());
    const aspLeaves = await fetchAspLeaves(rpcUrl, deployment.aspMembership, 1);
    this.pool.aspRebuild(aspLeaves);
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
    const tvk = deriveTvk(this.account.mvkSecret, FEE_SCOPE);
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
  }): SendHandle {
    const handle = new SendHandle(`send-${++opCounter}`);
    // Kick off async work without blocking the caller (optimistic UI).
    void this.runSend(handle, opts);
    return handle;
  }

  private async runSend(
    handle: SendHandle,
    opts: { amount: bigint; to: BenzoRecipient; memo?: string; useRelayer?: boolean },
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

      const senderTvk = deriveTvk(this.account.mvkSecret, FEE_SCOPE);
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
      handle._resolve({ txHash: tr.txHash, amount: opts.amount, recipient: opts.to.label, provingMs: tr.provingMs });
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
        fnArgs: [
          "transfer", "--submitter", submitter, "--root", a.root,
          "--nullifier0", a.nullifier0, "--nullifier1", a.nullifier1,
          "--out_commitment0", a.outCommitment0, "--out_commitment1", a.outCommitment1,
          "--fee", a.fee, "--relayer", a.relayerAddress,
          "--mvk_tag0", a.mvkTag0, "--mvk_tag1", a.mvkTag1,
          "--note_ct0", a.noteCt0, "--note_ct1", a.noteCt1,
          "--mvk_ct0", a.mvkCt0, "--mvk_ct1", a.mvkCt1, "--proof", a.proof,
        ],
      });
      return { txHash: res.txHash };
    };
  }

  // ---------------------------------------------------------- unshield ----

  /** Unshield public USDC to a Stellar address (proof-of-innocence enforced). */
  async unshield(opts: {
    amount: bigint;
    toAddress: string;
  }): Promise<{ txHash?: string; nullifier: bigint; provingMs: number }> {
    await this.sync();
    const assetId = await this.assetId();
    const input = this.selectNote(opts.amount);
    if (!input) throw new Error("insufficient spendable balance");
    const changeAmount = input.note.amount - opts.amount;
    const changeNote = newNote(changeAmount, this.account.spendPub, assetId);
    const changePlain = encodeNotePlain({ ...changeNote });
    const tvk = deriveTvk(this.account.mvkSecret, FEE_SCOPE);
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
  shareReceipt(scope = FEE_SCOPE): {
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
  disclose(scope = FEE_SCOPE) {
    return this.shareReceipt(scope);
  }

  // --------------------------------------------------------- @handle -----

  /**
   * Register this account's public payment address under a `@handle` in the
   * on-chain registry. `ownerAddress`/`ownerSource` authorize the entry.
   */
  async registerHandle(opts: {
    handle: string;
    ownerAddress: string;
    ownerSource: string;
  }): Promise<{ txHash?: string }> {
    if (!this.opts.handleRegistry) throw new Error("no handle registry configured");
    const res = await this.opts.cli.invoke({
      contractId: this.opts.handleRegistry,
      source: opts.ownerSource,
      send: true,
      fnArgs: [
        "register",
        "--handle", opts.handle,
        "--owner", opts.ownerAddress,
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
      viewPub: new Uint8Array(Buffer.from(rec.view_pub, "hex")),
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
    const link = `benzo://claim#${Buffer.from(secret).toString("base64url")}`;
    return { link, claimSecretHex: Buffer.from(secret).toString("hex"), sendTx: r?.txHash, recipient: to };
  }

  /** Parse a claim link into its claim secret. */
  static parseClaimLink(link: string): Uint8Array {
    const frag = link.split("#")[1];
    if (!frag) throw new Error("invalid claim link");
    return new Uint8Array(Buffer.from(frag, "base64url"));
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
