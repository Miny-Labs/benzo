import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let sqlClient: NeonQueryFunction<false, false> | null | undefined;
let schemaReady: Promise<void> | null = null;
const memoryDocuments = new Map<string, string>();

function useMemoryStore(): boolean {
  if (process.env.VERCEL === "1" && process.env.BENZO_TENANT_STORE_MEMORY === "1") {
    throw new Error("BENZO_TENANT_STORE_MEMORY is not allowed on Vercel hosted tenant storage");
  }
  return process.env.BENZO_TENANT_STORE_MEMORY === "1";
}

function encryptionSecret(): string | null {
  const secret = process.env.BENZO_DATA_ENCRYPTION_SECRET;
  if (!secret && process.env.VERCEL === "1") throw new Error("BENZO_DATA_ENCRYPTION_SECRET is required for hosted tenant storage");
  return secret || null;
}

function sql(): NeonQueryFunction<false, false> | null {
  if (sqlClient !== undefined) return sqlClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL === "1") throw new Error("DATABASE_URL is required for hosted tenant storage");
    sqlClient = null;
    return null;
  }
  sqlClient = neon(url);
  return sqlClient;
}

async function ensureSchema(): Promise<void> {
  const db = sql();
  if (!db) return;
  schemaReady ??= db`
    create table if not exists benzo_tenant_documents (
      app text not null,
      tenant_key text not null,
      version integer not null default 1,
      ciphertext text not null,
      updated_at timestamptz not null default now(),
      primary key (app, tenant_key)
    )
  `.then(() => undefined);
  await schemaReady;
}

function key(): Buffer {
  const secret = encryptionSecret();
  if (!secret) throw new Error("tenant storage encryption unavailable");
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

function decrypt<T>(ciphertext: string): T {
  const raw = Buffer.from(ciphertext, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
}

export function tenantStorageMissing(): string[] {
  const missing: string[] = [];
  if (process.env.VERCEL === "1") {
    if (process.env.BENZO_TENANT_STORE_MEMORY === "1") missing.push("BENZO_TENANT_STORE_MEMORY");
    if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
    if (!process.env.BENZO_DATA_ENCRYPTION_SECRET) missing.push("BENZO_DATA_ENCRYPTION_SECRET");
  }
  return missing;
}

export async function loadTenantDocument<T>(app: string, tenantKey: string): Promise<T | null> {
  if (useMemoryStore()) {
    const ciphertext = memoryDocuments.get(`${app}:${tenantKey}`);
    return ciphertext ? decrypt<T>(ciphertext) : null;
  }
  await ensureSchema();
  const db = sql();
  if (!db) return null;
  const rows = await db`select ciphertext from benzo_tenant_documents where app = ${app} and tenant_key = ${tenantKey} limit 1`;
  const row = rows[0] as { ciphertext?: string } | undefined;
  return row?.ciphertext ? decrypt<T>(row.ciphertext) : null;
}

export async function saveTenantDocument(app: string, tenantKey: string, value: unknown): Promise<void> {
  if (useMemoryStore()) {
    memoryDocuments.set(`${app}:${tenantKey}`, encrypt(value));
    return;
  }
  await ensureSchema();
  const db = sql();
  if (!db) return;
  const ciphertext = encrypt(value);
  await db`
    insert into benzo_tenant_documents (app, tenant_key, ciphertext, updated_at)
    values (${app}, ${tenantKey}, ${ciphertext}, now())
    on conflict (app, tenant_key)
    do update set ciphertext = excluded.ciphertext, updated_at = now()
  `;
}
