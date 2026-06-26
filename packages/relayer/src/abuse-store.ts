import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface CachedResponse {
  code: number;
  body: unknown;
  at: number;
}

export interface RelayerAbuseStore {
  durable: boolean;
  allow(key: string, burst: number, perMin: number): Promise<boolean>;
  takeDaily(key: string, max: number): Promise<boolean>;
  idemGet(key: string, ttlMs: number): Promise<CachedResponse | undefined>;
  idemSet(key: string, value: CachedResponse): Promise<void>;
}

interface MemoryBucket {
  tokens: number;
  last: number;
}

class MemoryRelayerAbuseStore implements RelayerAbuseStore {
  readonly durable = false;
  private readonly buckets = new Map<string, MemoryBucket>();
  private readonly daily = new Map<string, number>();
  private readonly idempotency = new Map<string, CachedResponse>();

  async allow(key: string, burst: number, perMin: number): Promise<boolean> {
    const now = Date.now();
    const refillPerMs = perMin / 60_000;
    const b = this.buckets.get(key) ?? { tokens: burst, last: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  async takeDaily(key: string, max: number): Promise<boolean> {
    const count = this.daily.get(key) ?? 0;
    if (count >= max) return false;
    this.daily.set(key, count + 1);
    return true;
  }

  async idemGet(key: string, ttlMs: number): Promise<CachedResponse | undefined> {
    const c = this.idempotency.get(key);
    if (!c) return undefined;
    if (Date.now() - c.at > ttlMs) {
      this.idempotency.delete(key);
      return undefined;
    }
    return c;
  }

  async idemSet(key: string, value: CachedResponse): Promise<void> {
    this.idempotency.set(key, value);
  }
}

class NeonRelayerAbuseStore implements RelayerAbuseStore {
  readonly durable = true;
  private readonly db: NeonQueryFunction<false, false>;
  private schemaReady: Promise<void> | null = null;

  constructor(url: string) {
    this.db = neon(url);
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.db`
      create table if not exists benzo_relayer_abuse (
        kind text not null,
        key text not null,
        tokens double precision,
        last_ms bigint,
        count integer,
        code integer,
        body jsonb,
        updated_at timestamptz not null default now(),
        primary key (kind, key)
      )
    `.then(() => undefined);
    await this.schemaReady;
  }

  async allow(key: string, burst: number, perMin: number): Promise<boolean> {
    await this.ensureSchema();
    const now = Date.now();
    const refillPerMs = perMin / 60_000;
    const rows = await this.db`
      insert into benzo_relayer_abuse (kind, key, tokens, last_ms, updated_at)
      values ('bucket', ${key}, ${Math.max(0, burst - 1)}, ${now}, now())
      on conflict (kind, key) do update set
        tokens = least(${burst}, benzo_relayer_abuse.tokens + ((${now} - benzo_relayer_abuse.last_ms) * ${refillPerMs})) - 1,
        last_ms = ${now},
        updated_at = now()
      where least(${burst}, benzo_relayer_abuse.tokens + ((${now} - benzo_relayer_abuse.last_ms) * ${refillPerMs})) >= 1
      returning tokens
    `;
    return rows.length > 0;
  }

  async takeDaily(key: string, max: number): Promise<boolean> {
    await this.ensureSchema();
    const rows = await this.db`
      insert into benzo_relayer_abuse (kind, key, count, updated_at)
      values ('daily', ${key}, 1, now())
      on conflict (kind, key) do update set
        count = benzo_relayer_abuse.count + 1,
        updated_at = now()
      where benzo_relayer_abuse.count < ${max}
      returning count
    `;
    return rows.length > 0;
  }

  async idemGet(key: string, ttlMs: number): Promise<CachedResponse | undefined> {
    await this.ensureSchema();
    const cutoff = Date.now() - ttlMs;
    const rows = await this.db`
      select code, body, last_ms
      from benzo_relayer_abuse
      where kind = 'idempotency' and key = ${key} and last_ms >= ${cutoff}
      limit 1
    `;
    const row = rows[0] as { code?: number; body?: unknown; last_ms?: string | number } | undefined;
    if (!row || typeof row.code !== "number") return undefined;
    return { code: row.code, body: row.body, at: Number(row.last_ms ?? Date.now()) };
  }

  async idemSet(key: string, value: CachedResponse): Promise<void> {
    await this.ensureSchema();
    await this.db`
      insert into benzo_relayer_abuse (kind, key, code, body, last_ms, updated_at)
      values ('idempotency', ${key}, ${value.code}, ${JSON.stringify(value.body)}::jsonb, ${value.at}, now())
      on conflict (kind, key) do update set
        code = excluded.code,
        body = excluded.body,
        last_ms = excluded.last_ms,
        updated_at = now()
    `;
  }
}

export function createRelayerAbuseStore(env: NodeJS.ProcessEnv = process.env): RelayerAbuseStore {
  if (env.RELAYER_STORE_MEMORY === "1") return new MemoryRelayerAbuseStore();
  if (env.DATABASE_URL) return new NeonRelayerAbuseStore(env.DATABASE_URL);
  if (env.NODE_ENV === "production" || env.VERCEL === "1") {
    throw new Error("DATABASE_URL is required for durable relayer rate limits and idempotency");
  }
  return new MemoryRelayerAbuseStore();
}
