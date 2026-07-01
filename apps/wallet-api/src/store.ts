/**
 * Consumer-side product state. Hosted requests use an encrypted per-auth tenant
 * document; local dev keeps the old in-process seed for fast testnet work.
 * Balance and chain history still come from @benzo/core.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AccountBinding } from "./auth.js";
import { hostedRuntime } from "./runtime.js";
import { deleteTenantDocument, loadTenantDocument, saveTenantDocument, tenantStorageMissing } from "./tenantData.js";
export type Direction = "in" | "out";

export interface Contact {
  handle: string; // "@mara"
  name: string;
  tone?: "accent" | "amber" | "neutral";
}

export interface ActivityRow {
  id: string;
  /** shield | send | receive | unshield | cashIn | cashOut */
  type: string;
  name: string; // display name / @handle
  note: string; // plain-English line ("Paid you · Design work")
  amount: string; // stroops
  direction: Direction;
  status: "settled" | "pending" | "proving" | "arriving" | "failed";
  timestamp: number; // unix seconds
  txHash?: string;
  tone?: "accent" | "amber" | "neutral";
  /** true only for legacy unverified rows; live chain rows never set this. */
  unverified?: boolean;
}

export interface ProofReceipt {
  id: string;
  action: string;
  vkId: string;
  prover?: string;
  verified: boolean;
  publicInputs?: unknown;
  txHash?: string;
  verifier?: string;
  createdAt: number;
}

export interface IdempotencyRecord {
  bodyHash: string;
  status: number;
  body: unknown;
  createdAt: number;
}

export interface WalletInvite {
  localId: string;
  amount: string;
  note?: string;
  link: string;
  /** encrypted in the tenant document; needed by the sender to refund. */
  secret: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "claimed" | "refunded" | "expired";
}

export type WalletLedgerSource =
  | "onramp"
  | "offramp"
  | "import"
  | "make_public"
  | "send_public"
  | "send_private"
  | "invite_fund"
  | "invite_claim"
  | "invite_refund";

export type WalletLedgerAccount = "private" | "public" | "ramp_reserve" | "external" | "claim_escrow";

export interface WalletLedgerLine {
  accountId: WalletLedgerAccount;
  direction: "debit" | "credit";
  amount: string;
  assetCode: "USDC";
}

export interface WalletLedgerEntry {
  id: string;
  postedAt: number;
  sourceType: WalletLedgerSource;
  sourceId?: string;
  status: "settled" | "failed";
  txId?: string;
  prover?: string;
  requestedAmount?: string;
  counterparty?: string;
  lines: WalletLedgerLine[];
  errorCode?: string;
  error?: string;
  hash?: string;
}

export interface Profile {
  handle: string;
  name: string;
}

export interface RecoveryBinding {
  accountFingerprint: string;
  subjectKey: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RecoverySummary {
  bound: boolean;
  createdAt?: number;
  lastSeenAt?: number;
  status: "unbound" | "healthy";
  custody: "non-custodial";
  nextSteps: string[];
}

export class RecoveryRequiredError extends Error {
  readonly code = "account_binding_changed";
  constructor(
    readonly storedAccountFingerprint: string,
    readonly currentAccountFingerprint: string,
  ) {
    super("This account needs recovery before it can use this wallet.");
  }
}

let seq = 0;
export function id(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Date.now().toString(36)}`;
}
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
export interface WalletDb {
  accountGeneration: number;
  profile: Profile;
  contacts: Contact[];
  activity: ActivityRow[];
  invites: WalletInvite[];
  ledger: WalletLedgerEntry[];
  recovery: RecoveryBinding | null;
  proofReceipts: ProofReceipt[];
  idempotency: Record<string, IdempotencyRecord>;
  requestReconciledTxs: Record<string, string[]>;
  /** @benzo/core scanner snapshots, ASP cache, and transaction journal. */
  coreState: Record<string, string>;
}

export function seed(): WalletDb {
  return {
    accountGeneration: 0,
    profile: { handle: "@you", name: "You" },
    contacts: [],
    activity: [],
    invites: [],
    ledger: [],
    recovery: null,
    proofReceipts: [],
    idempotency: {},
    requestReconciledTxs: {},
    coreState: {},
  };
}

const localDb: WalletDb = seed();
const tenantScope = new AsyncLocalStorage<{ key: string; db: WalletDb; deleted?: boolean }>();

function activeDb(): WalletDb {
  return tenantScope.getStore()?.db ?? localDb;
}

export const db: WalletDb = new Proxy({} as WalletDb, {
  get(_target, prop: keyof WalletDb) {
    return activeDb()[prop];
  },
  set(_target, prop: keyof WalletDb, value) {
    activeDb()[prop] = value as never;
    return true;
  },
  has(_target, prop) {
    return prop in activeDb();
  },
  ownKeys() {
    return Reflect.ownKeys(activeDb());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(activeDb(), prop);
  },
});

export function tenantDataMissing(): string[] {
  return tenantStorageMissing();
}

export function currentWalletTenantKey(): string | null {
  return tenantScope.getStore()?.key ?? null;
}

export async function persistCurrentWalletTenant(): Promise<void> {
  const ctx = tenantScope.getStore();
  if (!ctx || ctx.deleted) return;
  await saveWalletTenantDocument(ctx.key, ctx.db);
}

export async function deleteCurrentWalletTenant(): Promise<void> {
  const ctx = tenantScope.getStore();
  if (!ctx) {
    Object.assign(localDb, seed());
    return;
  }
  const accountGeneration = Number(ctx.db.accountGeneration ?? 0) + 1;
  await deleteTenantDocument("wallet", ctx.key);
  Object.assign(ctx.db, seed(), { accountGeneration });
}

function hostedTenantMode(): boolean {
  return hostedRuntime() || process.env.BENZO_HOSTED_TENANT_TEST === "1";
}

function canonicalLedgerEntry(e: WalletLedgerEntry): string {
  const { hash: _hash, ...rest } = e;
  return JSON.stringify(rest);
}

function ledgerHash(prevHash: string | undefined, e: WalletLedgerEntry): string {
  return createHash("sha256").update(`${prevHash ?? "GENESIS"}:${canonicalLedgerEntry(e)}`).digest("hex");
}

function rechainWalletLedger(entries: WalletLedgerEntry[]): WalletLedgerEntry[] {
  let prev: string | undefined;
  return entries.map((entry) => {
    const next = { ...entry };
    next.hash = ledgerHash(prev, next);
    prev = next.hash;
    return next;
  });
}

export function verifyWalletLedgerEntries(entries: WalletLedgerEntry[]): { ok: boolean; length: number; brokenAt?: number } {
  let prev: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].hash !== ledgerHash(prev, entries[i])) return { ok: false, length: entries.length, brokenAt: i };
    prev = entries[i].hash;
  }
  return { ok: true, length: entries.length };
}

export function appendWalletLedger(entry: Omit<WalletLedgerEntry, "id" | "postedAt" | "hash"> & { id?: string; postedAt?: number }): WalletLedgerEntry {
  db.ledger ??= [];
  const next: WalletLedgerEntry = {
    id: entry.id ?? id("wle"),
    postedAt: entry.postedAt ?? nowSec(),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    status: entry.status,
    txId: entry.txId,
    prover: entry.prover,
    requestedAmount: entry.requestedAmount,
    counterparty: entry.counterparty,
    lines: entry.lines,
    errorCode: entry.errorCode,
    error: entry.error,
  };
  next.hash = ledgerHash(db.ledger[db.ledger.length - 1]?.hash, next);
  db.ledger.push(next);
  return next;
}

export function appendWalletProofReceipt(entry: Omit<ProofReceipt, "id" | "createdAt"> & { id?: string; createdAt?: number }): ProofReceipt {
  db.proofReceipts ??= [];
  const next: ProofReceipt = {
    id: entry.id ?? id("prf"),
    action: entry.action,
    vkId: entry.vkId,
    prover: entry.prover,
    verified: entry.verified,
    publicInputs: entry.publicInputs,
    txHash: entry.txHash,
    verifier: entry.verifier,
    createdAt: entry.createdAt ?? nowSec(),
  };
  db.proofReceipts.push(next);
  return next;
}

function canonicalTxHash(txHash: string): string {
  return txHash.trim().toLowerCase();
}

export function isRequestTxReconciled(requestId: string, txHash: string): boolean {
  const id = requestId.trim();
  const tx = canonicalTxHash(txHash);
  if (!id || !tx) return false;
  return new Set(db.requestReconciledTxs?.[id] ?? []).has(tx);
}

export function markRequestTxReconciled(requestId: string, txHash: string): void {
  const id = requestId.trim();
  const tx = canonicalTxHash(txHash);
  if (!id || !tx) return;
  db.requestReconciledTxs ??= {};
  const set = new Set(db.requestReconciledTxs[id] ?? []);
  set.add(tx);
  db.requestReconciledTxs[id] = [...set].sort();
}

export function verifyWalletLedger(): { ok: boolean; length: number; brokenAt?: number } {
  db.ledger ??= [];
  return verifyWalletLedgerEntries(db.ledger);
}

export function hasSettledWalletLedgerEntries(): boolean {
  return (db.ledger ?? []).some((entry) => entry.status === "settled");
}

export function walletLedgerBalances(): Record<WalletLedgerAccount, string> {
  db.ledger ??= [];
  const balances: Record<WalletLedgerAccount, bigint> = {
    private: 0n,
    public: 0n,
    ramp_reserve: 0n,
    external: 0n,
    claim_escrow: 0n,
  };
  for (const entry of db.ledger) {
    if (entry.status !== "settled") continue;
    for (const line of entry.lines) {
      const amount = BigInt(line.amount || "0");
      balances[line.accountId] += line.direction === "credit" ? amount : -amount;
    }
  }
  return {
    private: balances.private.toString(),
    public: balances.public.toString(),
    ramp_reserve: balances.ramp_reserve.toString(),
    external: balances.external.toString(),
    claim_escrow: balances.claim_escrow.toString(),
  };
}

function normalizeWalletDb(value: WalletDb): WalletDb {
  value.accountGeneration ??= 0;
  value.profile ??= { handle: "@you", name: "You" };
  value.contacts ??= [];
  value.activity ??= [];
  value.invites ??= [];
  value.ledger ??= [];
  value.recovery ??= null;
  value.proofReceipts ??= [];
  value.idempotency ??= {};
  value.requestReconciledTxs ??= {};
  value.coreState ??= {};
  return value;
}

function isSeedHandle(handle: string | undefined): boolean {
  const h = (handle ?? "").trim().toLowerCase();
  return h === "" || h === "@you" || h === "you";
}

function keyed<T>(items: T[], keyOf: (item: T) => string | undefined): T[] {
  const order: string[] = [];
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item) ?? JSON.stringify(item);
    if (!map.has(key)) order.push(key);
    map.set(key, item);
  }
  return order.map((key) => map.get(key)!);
}

function mergeAppendOnly<T>(
  current: T[] | undefined,
  next: T[] | undefined,
  keyOf: (item: T) => string | undefined,
): T[] {
  return keyed([...(current ?? []), ...(next ?? [])], keyOf);
}

function mergeStringArrayRecords(
  current: Record<string, string[]> | undefined,
  next: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of [current, next]) {
    for (const [key, values] of Object.entries(source ?? {})) {
      const set = new Set(merged[key] ?? []);
      for (const value of values ?? []) {
        const normalized = canonicalTxHash(value);
        if (normalized) set.add(normalized);
      }
      merged[key] = [...set].sort();
    }
  }
  return merged;
}

export function mergeWalletDbForSave(currentInput: WalletDb, nextInput: WalletDb): WalletDb {
  const current = normalizeWalletDb(JSON.parse(JSON.stringify(currentInput)) as WalletDb);
  const next = normalizeWalletDb(JSON.parse(JSON.stringify(nextInput)) as WalletDb);
  const merged: WalletDb = {
    ...current,
    ...next,
    accountGeneration: Math.max(Number(current.accountGeneration ?? 0), Number(next.accountGeneration ?? 0)),
    profile: next.profile,
    contacts: mergeAppendOnly(current.contacts, next.contacts, (c) => c.handle?.toLowerCase()),
    activity: mergeAppendOnly(current.activity, next.activity, (a) => a.id || a.txHash || `${a.type}:${a.timestamp}:${a.amount}:${a.direction}`),
    invites: mergeAppendOnly(current.invites, next.invites, (i) => i.localId),
    ledger: rechainWalletLedger(mergeAppendOnly(current.ledger, next.ledger, (e) => e.id || e.hash || e.txId)),
    proofReceipts: mergeAppendOnly(current.proofReceipts, next.proofReceipts, (r) => r.id || `${r.action}:${r.txHash ?? ""}:${r.createdAt}`),
    idempotency: { ...(current.idempotency ?? {}), ...(next.idempotency ?? {}) },
    requestReconciledTxs: mergeStringArrayRecords(current.requestReconciledTxs, next.requestReconciledTxs),
    coreState: {},
  };
  if (isSeedHandle(next.profile?.handle) && !isSeedHandle(current.profile?.handle)) {
    merged.profile = current.profile;
  }
  return normalizeWalletDb(merged);
}

async function migrateLegacyCoreState(tenantKey: string, value: WalletDb): Promise<boolean> {
  const entries = Object.entries(value.coreState ?? {});
  if (entries.length === 0) return false;
  for (const [key, state] of entries) {
    await saveTenantDocument("wallet-core", `${tenantKey}:${key}`, { value: state });
  }
  value.coreState = {};
  return true;
}

async function saveWalletTenantDocument(tenantKey: string, next: WalletDb): Promise<void> {
  await migrateLegacyCoreState(tenantKey, next);
  const current = await loadTenantDocument<WalletDb>("wallet", tenantKey);
  const toSave = current ? mergeWalletDbForSave(current, next) : normalizeWalletDb(next);
  await saveTenantDocument("wallet", tenantKey, toSave);
}

function bindRecovery(value: WalletDb, binding: AccountBinding | null): void {
  if (!binding) return;
  const seenAt = nowSec();
  if (!value.recovery) {
    value.recovery = {
      accountFingerprint: binding.accountFingerprint,
      subjectKey: binding.subjectKey,
      createdAt: seenAt,
      lastSeenAt: seenAt,
    };
    return;
  }
  if (value.recovery.accountFingerprint !== binding.accountFingerprint) {
    throw new RecoveryRequiredError(value.recovery.accountFingerprint, binding.accountFingerprint);
  }
  value.recovery.subjectKey = binding.subjectKey;
  value.recovery.lastSeenAt = seenAt;
}

export function recoverySummary(): RecoverySummary {
  const recovery = db.recovery;
  if (!recovery) {
    return {
      bound: false,
      status: "unbound",
      custody: "non-custodial",
      nextSteps: [
        "Finish sign-in on this device to bind the wallet key.",
        "After binding, use the same Google account to keep the same shielded account.",
      ],
    };
  }
  return {
    bound: true,
    status: "healthy",
    custody: "non-custodial",
    createdAt: recovery.createdAt,
    lastSeenAt: recovery.lastSeenAt,
    nextSteps: [
      "Use this Google sign-in to keep access to the same shielded account.",
      "If your account or account salt changes, sign back in with the original account or request a reviewed migration.",
    ],
  };
}

export async function runWithWalletTenant<T>(
  authKey: string | null,
  claims: { name?: string; email?: string } | null,
  binding: AccountBinding | null,
  fn: () => Promise<T>,
  opts: { persist?: boolean } = {},
): Promise<T> {
  if (!hostedTenantMode() || !authKey) return fn();
  const tenantKey = `wallet:${authKey}`;
  const loaded = await loadTenantDocument<WalletDb>("wallet", tenantKey);
  const fresh = seed();
  if (claims?.name) fresh.profile.name = claims.name;
  if (claims?.email && fresh.profile.name === "You") fresh.profile.name = claims.email.split("@")[0] || "You";
  const ctx: { key: string; db: WalletDb; deleted?: boolean } = { key: tenantKey, db: normalizeWalletDb(loaded ?? fresh) };
  const migratedCoreState = await migrateLegacyCoreState(tenantKey, ctx.db);
  bindRecovery(ctx.db, binding);
  return tenantScope.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      if (!ctx.deleted && (opts.persist !== false || migratedCoreState)) await saveWalletTenantDocument(tenantKey, ctx.db);
    }
  });
}
