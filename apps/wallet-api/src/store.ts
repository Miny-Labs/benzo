/**
 * Consumer-side product state. Hosted requests use an encrypted per-auth tenant
 * document; local dev keeps the old in-process seed for fast testnet work.
 * Balance and chain history still come from @benzo/core.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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

export interface Profile {
  handle: string;
  name: string;
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
  rateLimits: Record<string, RateBucket>;
  proofReceipts: ProofReceipt[];
  idempotency: Record<string, IdempotencyRecord>;
}

export function seed(): WalletDb {
  return {
    profile: { handle: "@you", name: "You" },
    contacts: [],
    activity: [],
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

export async function runWithWalletTenant<T>(
  authKey: string | null,
  claims: { name?: string; email?: string } | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.env.VERCEL !== "1" || !authKey) return fn();
  const tenantKey = `wallet:${authKey}`;
  const loaded = await loadTenantDocument<WalletDb>("wallet", tenantKey);
  const fresh = seed();
  if (claims?.name) fresh.profile.name = claims.name;
  if (claims?.email && fresh.profile.name === "You") fresh.profile.name = claims.email.split("@")[0] || "You";
  const ctx = { key: tenantKey, db: loaded ?? fresh };
  return tenantScope.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      await saveTenantDocument("wallet", tenantKey, ctx.db);
    }
  });
}
