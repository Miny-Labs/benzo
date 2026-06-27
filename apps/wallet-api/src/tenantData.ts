import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { hostedRuntime } from "./runtime.js";

let sqlClient: NeonQueryFunction<false, false> | null | undefined;
let schemaReady: Promise<void> | null = null;
const memoryDocuments = new Map<string, string>();
const memoryRateLimits = new Map<string, { windowStart: number; count: number }>();

function useMemoryStore(): boolean {
  if (hostedRuntime() && process.env.BENZO_TENANT_STORE_MEMORY === "1") {
    throw new Error("BENZO_TENANT_STORE_MEMORY is not allowed for hosted tenant storage");
  }
  return process.env.BENZO_TENANT_STORE_MEMORY === "1";
}

function encryptionSecret(): string | null {
  const secret = process.env.BENZO_DATA_ENCRYPTION_SECRET;
  if (!secret && hostedRuntime()) throw new Error("BENZO_DATA_ENCRYPTION_SECRET is required for hosted tenant storage");
  return secret || null;
}

function sql(): NeonQueryFunction<false, false> | null {
  if (sqlClient !== undefined) return sqlClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (hostedRuntime()) throw new Error("DATABASE_URL is required for hosted tenant storage");
    sqlClient = null;
    return null;
  }
  sqlClient = neon(url);
  return sqlClient;
}

async function ensureSchema(): Promise<void> {
  const db = sql();
  if (!db) return;
  schemaReady ??= (async () => {
    await db`
      create table if not exists benzo_tenant_documents (
        app text not null,
        tenant_key text not null,
        version integer not null default 1,
        ciphertext text not null,
        updated_at timestamptz not null default now(),
        primary key (app, tenant_key)
      )
    `;
    await db`
      create table if not exists benzo_request_limits (
        app text not null,
        tenant_key text not null,
        bucket text not null,
        window_start bigint not null,
        count integer not null,
        updated_at timestamptz not null default now(),
        primary key (app, tenant_key, bucket)
      )
    `;
  })();
  await schemaReady;
}

function key(): Buffer {
  const secret = encryptionSecret();
  if (!secret) throw new Error("tenant storage encryption unavailable");
  return createHash("sha256").update(secret).digest();
}

function tenantAad(app: string, tenantKey: string): Buffer {
  return Buffer.from(`benzo:tenant-doc:v1:${app}:${tenantKey}`, "utf8");
}

function encrypt(app: string, tenantKey: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(tenantAad(app, tenantKey));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

function decryptBound<T>(app: string, tenantKey: string, ciphertext: string): T {
  const raw = Buffer.from(ciphertext, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(tenantAad(app, tenantKey));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
}

function decryptLegacy<T>(ciphertext: string): T {
  const raw = Buffer.from(ciphertext, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
}

function decrypt<T>(app: string, tenantKey: string, ciphertext: string): T {
  try {
    return decryptBound<T>(app, tenantKey, ciphertext);
  } catch (error) {
    if (process.env.BENZO_DISABLE_TENANT_LEGACY_DECRYPT === "1") throw error;
    return decryptLegacy<T>(ciphertext);
  }
}

export function tenantStorageMissing(): string[] {
  const missing: string[] = [];
  if (hostedRuntime()) {
    if (process.env.BENZO_TENANT_STORE_MEMORY === "1") missing.push("BENZO_TENANT_STORE_MEMORY");
    if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
    if (!process.env.BENZO_DATA_ENCRYPTION_SECRET) missing.push("BENZO_DATA_ENCRYPTION_SECRET");
  }
  return missing;
}

export async function loadTenantDocument<T>(app: string, tenantKey: string): Promise<T | null> {
  if (useMemoryStore()) {
    const ciphertext = memoryDocuments.get(`${app}:${tenantKey}`);
    return ciphertext ? decrypt<T>(app, tenantKey, ciphertext) : null;
  }
  await ensureSchema();
  const db = sql();
  if (!db) return null;
  const rows = await db`select ciphertext from benzo_tenant_documents where app = ${app} and tenant_key = ${tenantKey} limit 1`;
  const row = rows[0] as { ciphertext?: string } | undefined;
  return row?.ciphertext ? decrypt<T>(app, tenantKey, row.ciphertext) : null;
}

export async function saveTenantDocument(app: string, tenantKey: string, value: unknown): Promise<void> {
  if (useMemoryStore()) {
    memoryDocuments.set(`${app}:${tenantKey}`, encrypt(app, tenantKey, value));
    return;
  }
  await ensureSchema();
  const db = sql();
  if (!db) return;
  const ciphertext = encrypt(app, tenantKey, value);
  await db`
    insert into benzo_tenant_documents (app, tenant_key, ciphertext, updated_at)
    values (${app}, ${tenantKey}, ${ciphertext}, now())
    on conflict (app, tenant_key)
    do update set ciphertext = excluded.ciphertext, updated_at = now()
  `;
}

function currentWindow(nowSec: number, windowSeconds: number): number {
  return Math.floor(nowSec / windowSeconds) * windowSeconds;
}

function takeMemoryRateLimit(key: string, weight: number, limit: number, windowSeconds: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = currentWindow(now, windowSeconds);
  const bucket = memoryRateLimits.get(key) ?? { windowStart, count: 0 };
  if (bucket.windowStart !== windowStart) {
    bucket.windowStart = windowStart;
    bucket.count = 0;
  }
  bucket.count += weight;
  memoryRateLimits.set(key, bucket);
  if (bucket.count > limit) return { ok: false, retryAfter: Math.max(1, windowSeconds - (now - windowStart)) };
  return { ok: true };
}

export async function takeTenantRateLimit(
  app: string,
  tenantKey: string,
  bucketName: string,
  weight: number,
  limit: number,
  windowSeconds: number,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const key = `${app}:${tenantKey}:${bucketName}`;
  if (useMemoryStore()) return takeMemoryRateLimit(key, weight, limit, windowSeconds);
  await ensureSchema();
  const db = sql();
  if (!db) return takeMemoryRateLimit(key, weight, limit, windowSeconds);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = currentWindow(now, windowSeconds);
  const rows = await db`
    insert into benzo_request_limits (app, tenant_key, bucket, window_start, count, updated_at)
    values (${app}, ${tenantKey}, ${bucketName}, ${windowStart}, ${weight}, now())
    on conflict (app, tenant_key, bucket)
    do update set
      window_start = case
        when benzo_request_limits.window_start = ${windowStart} then benzo_request_limits.window_start
        else ${windowStart}
      end,
      count = case
        when benzo_request_limits.window_start = ${windowStart} then benzo_request_limits.count + ${weight}
        else ${weight}
      end,
      updated_at = now()
    returning count
  `;
  const count = Number((rows[0] as { count?: number | string } | undefined)?.count ?? weight);
  if (count > limit) return { ok: false, retryAfter: Math.max(1, windowSeconds - (now - windowStart)) };
  return { ok: true };
}
