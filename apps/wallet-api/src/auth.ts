import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { accountFromOidc, type BenzoAccount } from "@benzo/core";
import { verifyGoogleIdToken, type GoogleClaims } from "./google-oidc.js";
import { hostedRuntime } from "./runtime.js";

export interface AuthContext {
  key: string;
  account: BenzoAccount;
  claims: GoogleClaims;
}

export interface AccountBinding {
  accountFingerprint: string;
  subjectKey: string;
}

const storage = new AsyncLocalStorage<AuthContext>();

function accountSalt(): string {
  const salt = process.env.BENZO_ACCOUNT_SALT || process.env.BENZO_AUTH_SALT;
  if (!salt && hostedRuntime()) throw new Error("BENZO_ACCOUNT_SALT is required for hosted account derivation");
  return salt || "benzo-local-dev";
}

function fingerprintAccount(account: BenzoAccount): string {
  return createHash("sha256")
    .update(`wallet|${account.stellarAddress ?? ""}|${account.spendPub.toString()}|${account.mvkScalar.toString()}`)
    .digest("hex")
    .slice(0, 32);
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  return m?.[1]?.trim() || null;
}

const TEST_AUTH_PREFIX = "benzo-test-v1";
const TEST_AUTH_AUD = "benzo:wallet";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function testAuthSecret(): string | null {
  return hostedRuntime() ? process.env.BENZO_TEST_AUTH_SECRET || null : null;
}

export function createTestAuthToken(input: { subject?: string; email?: string; name?: string; ttlSeconds?: number } = {}): string {
  const secret = testAuthSecret();
  if (!secret) throw new Error("test auth is not enabled");
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 900, 3600));
  const payload: GoogleClaims = {
    iss: "benzo:test",
    aud: TEST_AUTH_AUD,
    sub: input.subject || "codex-vps-wallet",
    email: input.email,
    email_verified: true,
    name: input.name || "Codex VPS Wallet",
    exp: now + ttl,
  };
  const body = b64url(JSON.stringify(payload));
  const signed = `${TEST_AUTH_PREFIX}.${body}`;
  const sig = b64url(createHmac("sha256", secret).update(signed).digest());
  return `${signed}.${sig}`;
}

function verifyTestAuthToken(token: string): GoogleClaims | null {
  const secret = testAuthSecret();
  if (!secret || !token.startsWith(`${TEST_AUTH_PREFIX}.`)) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TEST_AUTH_PREFIX) throw new Error("malformed test auth token");
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = b64url(createHmac("sha256", secret).update(signed).digest());
  if (!safeEqual(parts[2], expected)) throw new Error("test auth token signature invalid");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as GoogleClaims;
  if (claims.iss !== "benzo:test" || claims.aud !== TEST_AUTH_AUD) throw new Error("test auth token audience invalid");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("test auth token expired");
  if (!claims.sub) throw new Error("test auth token has no sub");
  return claims;
}

export async function authFromRequest(req: IncomingMessage): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;
  const testClaims = verifyTestAuthToken(token);
  if (testClaims) {
    const key = createHash("sha256").update(`wallet|${testClaims.iss}|${testClaims.aud}|${testClaims.sub}`).digest("hex").slice(0, 32);
    const account = accountFromOidc(
      { iss: testClaims.iss, aud: testClaims.aud, sub: testClaims.sub },
      { app: "consumer", salt: accountSalt() },
    );
    account.label = `wallet-${key.slice(0, 8)}`;
    return { key, account, claims: testClaims };
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is required for hosted Google accounts");
  const claims = await verifyGoogleIdToken(token, clientId);
  const key = createHash("sha256").update(`wallet|${claims.iss}|${claims.aud}|${claims.sub}`).digest("hex").slice(0, 32);
  const account = accountFromOidc(
    { iss: claims.iss, aud: claims.aud, sub: claims.sub },
    { app: "consumer", salt: accountSalt() },
  );
  account.label = `wallet-${key.slice(0, 8)}`;
  return { key, account, claims };
}

export function runWithAuth<T>(ctx: AuthContext | null, fn: () => Promise<T>): Promise<T> {
  return ctx ? storage.run(ctx, fn) : fn();
}

export function currentAuth(): AuthContext | null {
  return storage.getStore() ?? null;
}

export function accountBinding(ctx: AuthContext): AccountBinding {
  return { accountFingerprint: fingerprintAccount(ctx.account), subjectKey: ctx.key };
}
