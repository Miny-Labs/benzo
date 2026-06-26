/**
 * Consumer-side product state. Hosted requests use an encrypted per-auth tenant
 * document; local dev keeps the old in-process seed for fast testnet work.
 * Balance and chain history still come from @benzo/core.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AccountBinding } from "./auth.js";
import { loadTenantDocument, saveTenantDocument, tenantStorageMissing } from "./tenantData.js";
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

export interface RateBucket {
  windowStart: number;
  count: number;
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
  profile: Profile;
  contacts: Contact[];
  activity: ActivityRow[];
  invites: WalletInvite[];
  ledger: WalletLedgerEntry[];
  recovery: RecoveryBinding | null;
  rateLimits: Record<string, RateBucket>;
  proofReceipts: ProofReceipt[];
  idempotency: Record<string, IdempotencyRecord>;
}

export function seed(): WalletDb {
  return {
    profile: { handle: "@you", name: "You" },
    contacts: [],
    activity: [],
    invites: [],
    ledger: [],
    recovery: null,
    rateLimits: {},
    proofReceipts: [],
    idempotency: {},
  };
}

const localDb: WalletDb = seed();
const tenantScope = new AsyncLocalStorage<{ key: string; db: WalletDb }>();

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

function hostedTenantMode(): boolean {
  return process.env.VERCEL === "1" || process.env.BENZO_HOSTED_TENANT_TEST === "1";
}

function canonicalLedgerEntry(e: WalletLedgerEntry): string {
  const { hash: _hash, ...rest } = e;
  return JSON.stringify(rest);
}

function ledgerHash(prevHash: string | undefined, e: WalletLedgerEntry): string {
  return createHash("sha256").update(`${prevHash ?? "GENESIS"}:${canonicalLedgerEntry(e)}`).digest("hex");
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

export function verifyWalletLedger(): { ok: boolean; length: number; brokenAt?: number } {
  db.ledger ??= [];
  let prev: string | undefined;
  for (let i = 0; i < db.ledger.length; i++) {
    if (db.ledger[i].hash !== ledgerHash(prev, db.ledger[i])) return { ok: false, length: db.ledger.length, brokenAt: i };
    prev = db.ledger[i].hash;
  }
  return { ok: true, length: db.ledger.length };
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
  value.contacts ??= [];
  value.activity ??= [];
  value.invites ??= [];
  value.ledger ??= [];
  value.recovery ??= null;
  value.rateLimits ??= {};
  value.proofReceipts ??= [];
  value.idempotency ??= {};
  return value;
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
  if (!recovery) return { bound: false };
  return {
    bound: true,
    createdAt: recovery.createdAt,
    lastSeenAt: recovery.lastSeenAt,
  };
}

export async function runWithWalletTenant<T>(
  authKey: string | null,
  claims: { name?: string; email?: string } | null,
  binding: AccountBinding | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!hostedTenantMode() || !authKey) return fn();
  const tenantKey = `wallet:${authKey}`;
  const loaded = await loadTenantDocument<WalletDb>("wallet", tenantKey);
  const fresh = seed();
  if (claims?.name) fresh.profile.name = claims.name;
  if (claims?.email && fresh.profile.name === "You") fresh.profile.name = claims.email.split("@")[0] || "You";
  const ctx = { key: tenantKey, db: normalizeWalletDb(loaded ?? fresh) };
  bindRecovery(ctx.db, binding);
  return tenantScope.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      await saveTenantDocument("wallet", tenantKey, ctx.db);
    }
  });
}
