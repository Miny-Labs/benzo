import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { accountFromOidc, type BenzoAccount } from "@benzo/core";
import { verifyGoogleIdToken, type GoogleClaims } from "./google-oidc.js";
import { hostedRuntime } from "./runtime.js";
import { loadTenantDocument, tenantStorageMissing } from "./tenantData.js";

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

export function accountFingerprint(account: BenzoAccount): string {
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
const DEVICE_AUTH_PREFIX = "benzo-device-v1";
const DEVICE_AUTH_ISS = "benzo:device";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function testAuthSecret(): string | null {
  return process.env.BENZO_TEST_AUTH_SECRET || null;
}


function deviceAuthSecret(): string {
  const secret = process.env.BENZO_DATA_ENCRYPTION_SECRET || process.env.BENZO_ACCOUNT_SALT || process.env.BENZO_AUTH_SALT;
  if (!secret && hostedRuntime()) throw new Error("BENZO_DATA_ENCRYPTION_SECRET is required for hosted device auth");
  return secret || "benzo-local-dev-device-auth";
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

export function createDeviceAuthToken(input: { address: string; name?: string; ttlSeconds?: number }): string {
  if (!input.address) throw new Error("device auth address required");
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 86_400, 604_800));
  const payload: GoogleClaims = {
    iss: DEVICE_AUTH_ISS,
    aud: TEST_AUTH_AUD,
    sub: input.address,
    email_verified: false,
    name: input.name || "Device wallet",
    exp: now + ttl,
  };
  const body = b64url(JSON.stringify(payload));
  const signed = `${DEVICE_AUTH_PREFIX}.${body}`;
  const sig = b64url(createHmac("sha256", deviceAuthSecret()).update(signed).digest());
  return `${signed}.${sig}`;
}

function verifyDeviceAuthToken(token: string): GoogleClaims | null {
  if (!token.startsWith(`${DEVICE_AUTH_PREFIX}.`)) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== DEVICE_AUTH_PREFIX) throw new Error("malformed device auth token");
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = b64url(createHmac("sha256", deviceAuthSecret()).update(signed).digest());
  if (!safeEqual(parts[2], expected)) throw new Error("device auth token signature invalid");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as GoogleClaims;
  if (claims.iss !== DEVICE_AUTH_ISS || claims.aud !== TEST_AUTH_AUD) throw new Error("device auth token audience invalid");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("device auth token expired");
  if (!claims.sub) throw new Error("device auth token has no sub");
  return claims;
}

function tenantKeyForClaims(claims: Pick<GoogleClaims, "iss" | "aud" | "sub">): string {
  return createHash("sha256").update(`wallet|${claims.iss}|${claims.aud}|${claims.sub}`).digest("hex").slice(0, 32);
}

async function accountGenerationForTenant(key: string): Promise<number> {
  if (!hostedRuntime()) return 0;
  if (tenantStorageMissing().length > 0) return 0;
  const doc = await loadTenantDocument<{ accountGeneration?: number }>("wallet", `wallet:${key}`);
  const generation = Number(doc?.accountGeneration ?? 0);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

async function deriveHostedAccount(claims: Pick<GoogleClaims, "iss" | "aud" | "sub">, key: string): Promise<BenzoAccount> {
  const generation = await accountGenerationForTenant(key);
  const baseSalt = accountSalt();
  const salt = generation === 0 ? baseSalt : `${baseSalt}:wallet-generation:${generation}`;
  const account = accountFromOidc(
    { iss: claims.iss, aud: claims.aud, sub: claims.sub },
    { app: "consumer", salt },
  );
  account.label = generation === 0 ? `wallet-${key.slice(0, 8)}` : `wallet-${key.slice(0, 8)}-g${generation}`;
  return account;
}

export async function authFromRequest(req: IncomingMessage): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;
  const testClaims = verifyTestAuthToken(token);
  if (testClaims) {
    const key = tenantKeyForClaims(testClaims);
    const account = await deriveHostedAccount(testClaims, key);
    return { key, account, claims: testClaims };
  }
  const deviceClaims = verifyDeviceAuthToken(token);
  if (deviceClaims) {
    const key = tenantKeyForClaims(deviceClaims);
    const account = await deriveHostedAccount(deviceClaims, key);
    return { key, account, claims: deviceClaims };
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is required for hosted Google accounts");
  const claims = await verifyGoogleIdToken(token, clientId);
  const key = tenantKeyForClaims(claims);
  const account = await deriveHostedAccount(claims, key);
  return { key, account, claims };
}

export function runWithAuth<T>(ctx: AuthContext | null, fn: () => Promise<T>): Promise<T> {
  return ctx ? storage.run(ctx, fn) : fn();
}

export function currentAuth(): AuthContext | null {
  return storage.getStore() ?? null;
}

export function accountBinding(ctx: AuthContext): AccountBinding {
  return { accountFingerprint: accountFingerprint(ctx.account), subjectKey: ctx.key };
}
