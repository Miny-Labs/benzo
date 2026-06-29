/**
 * @benzo/wallet-api — the BFF the consumer wallet UI calls. node:http, CORS-open
 * for local dev (add a bearer before exposing). On-chain ops route through
 * chain.ts (the @benzo/core seam). If the live chain client is unavailable, app
 * API routes fail closed instead of serving local state as live data.
 */
import "./loadEnv.js"; // FIRST: load .env so missing live env fails closed.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  addMoney,
  cashOut,
  claimHandle,
  claimInvite,
  createInvite,
  createRequest,
  cancelMoneyRequest,
  listInvites,
  refundInvite,
  getMoneyRequestStatus,
  reconcileMoneyRequest,
  getActivity,
  getBalanceStroops,
  getRampReserve,
  getDepositInfo,
  importDeposit,
  publicBalance,
  makePublic,
  sendPublic,
  getKycTier,
  handleAvailable,
  isLive,
  liveStatus,
  proverInfo,
  send,
  classifyRecipient,
  shareProof,
  walletVerifierId,
  exportAccountForDevice,
  relaySubmit,
  RampError,
  type ProverKind,
  type SendPhase,
  type SettleResult,
} from "./chain.js";
import {
  appendWalletLedger,
  appendWalletProofReceipt,
  currentWalletTenantKey,
  db,
  deleteCurrentWalletTenant,
  nowSec,
  recoverySummary,
  RecoveryRequiredError,
  runWithWalletTenant,
  tenantDataMissing,
  verifyWalletLedger,
  walletLedgerBalances,
  type WalletLedgerLine,
  type WalletLedgerSource,
} from "./store.js";
import { accountBinding, authFromRequest, createTestAuthToken, runWithAuth } from "./auth.js";
import { googleConfigured, verifyGoogleIdToken } from "./google-oidc.js";
import { takeTenantRateLimit } from "./tenantData.js";
import { hostedRuntime, serverlessRuntime } from "./runtime.js";

const PORT = Number(process.env.WALLET_API_PORT ?? 8791);
const rawBodies = new WeakMap<IncomingMessage, string>();
const idempotencyScope = new AsyncLocalStorage<{ key: string; bodyHash: string }>();
const localRateLimits = new Map<string, { windowStart: number; count: number }>();

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", process.env.WALLET_ALLOWED_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, idempotency-key, x-benzo-test-secret");
}
function json(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
  rememberIdempotency(code, body);
}
function rememberIdempotency(code: number, body: unknown): void {
  const idem = idempotencyScope.getStore();
  if (idem && code < 500) {
    db.idempotency ??= {};
    db.idempotency[idem.key] = { bodyHash: idem.bodyHash, status: code, body, createdAt: nowSec() };
  }
}
async function rawBody(req: IncomingMessage): Promise<string> {
  const cached = rawBodies.get(req);
  if (cached !== undefined) return cached;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  rawBodies.set(req, raw);
  return raw;
}
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await rawBody(req);
  return (raw ? JSON.parse(raw) : {}) as T;
}
class HostedLocalProverError extends Error {
  readonly code = "hosted_local_prover_disabled";
  constructor() {
    super("Hosted wallet APIs cannot run local proving. Prove in the browser on desktop, or use the TEE.");
  }
}

/** Read `prover` from query or body; hosted APIs can only delegate to the attested TEE. */
export function proverOf(url: URL, body?: { prover?: string }): ProverKind {
  const p = (url.searchParams.get("prover") || body?.prover || (hostedRuntime() ? "tee" : "local")).toLowerCase();
  if (hostedRuntime() && p !== "tee") throw new HostedLocalProverError();
  return p === "tee" ? "tee" : "local";
}

/** Clean ramp error body — a RampError carries a user-safe message + code; any
 *  other error is sanitized to generic copy so raw CLI/stack text never leaks. */
function rampError(e: unknown, dir: "in" | "out"): { error: string; code: string } {
  if (e instanceof RampError) return { error: e.message, code: e.code };
  return { error: dir === "in" ? "Couldn't add money right now. Your money is safe. Please try again." : "Couldn't cash out right now. Your money is safe. Please try again.", code: "busy" };
}
function sendError(e: unknown): { error: string; code: string } {
  if (e instanceof RampError) return { error: e.message, code: e.code };
  return { error: "Couldn't send right now. Your money is safe. Please try again.", code: "busy" };
}
function malformedHandle(to: string): boolean {
  const t = to.trim();
  return t.startsWith("@") && !/^[a-z0-9_.]{3,20}$/i.test(t.slice(1));
}
/** HTTP status for a ramp failure: 409 for a known business condition, 503 for transient. */
function rampStatus(e: unknown): number {
  if (e instanceof RampError) return e.code === "limit" ? 400 : e.code === "busy" ? 503 : 409;
  return 503;
}

function logRouteError(scope: string, e: unknown): void {
  const err = e as { message?: string; name?: string; stack?: string; code?: string };
  console.error(`[wallet-api] ${scope} failed`, {
    code: err?.code,
    name: err?.name,
    message: String(err?.message ?? e),
    stack: err?.stack,
  });
}

function ledgerError(e: unknown, dir: "in" | "out"): { error: string; code: string } {
  return rampError(e, dir);
}

function usdcLine(accountId: WalletLedgerLine["accountId"], direction: WalletLedgerLine["direction"], amount: string): WalletLedgerLine {
  return { accountId, direction, amount, assetCode: "USDC" };
}

function walletLedgerLines(sourceType: WalletLedgerSource, amount: string): WalletLedgerLine[] {
  switch (sourceType) {
    case "onramp":
      return [usdcLine("ramp_reserve", "debit", amount), usdcLine("private", "credit", amount)];
    case "offramp":
      return [usdcLine("private", "debit", amount), usdcLine("ramp_reserve", "credit", amount)];
    case "import":
      return [usdcLine("public", "debit", amount), usdcLine("private", "credit", amount)];
    case "make_public":
      return [usdcLine("private", "debit", amount), usdcLine("public", "credit", amount)];
    case "send_public":
      return [usdcLine("public", "debit", amount), usdcLine("external", "credit", amount)];
    case "send_private":
      return [usdcLine("private", "debit", amount), usdcLine("external", "credit", amount)];
    case "invite_fund":
      return [usdcLine("private", "debit", amount), usdcLine("claim_escrow", "credit", amount)];
    case "invite_claim":
    case "invite_refund":
      return [usdcLine("claim_escrow", "debit", amount), usdcLine("private", "credit", amount)];
  }
}

function recordSettledMovement(sourceType: WalletLedgerSource, amount: string, opts: { txHash?: string; prover?: string; sourceId?: string; requestedAmount?: string } = {}) {
  appendWalletLedger({
    sourceType,
    sourceId: opts.sourceId,
    status: "settled",
    txId: opts.txHash,
    prover: opts.prover,
    requestedAmount: opts.requestedAmount,
    lines: walletLedgerLines(sourceType, amount),
  });
}

type WalletSettlementVk = "SHIELD" | "TRANSFER" | "UNSHIELD";

function settlementPublicInputsRef(r: SettleResult): string[] | { source: "settlement-tx"; txHash: string | null } {
  if (r.sorobanPublics?.length) return r.sorobanPublics;
  return {
    source: "settlement-tx",
    txHash: r.txHash ?? null,
  };
}

function proofPublicInputsRef(
  r: { sorobanPublics?: string[]; txHash?: string; localId?: string },
): string[] | { source: "settlement-tx"; txHash: string | null; localId?: string } {
  if (r.sorobanPublics?.length) return r.sorobanPublics;
  return {
    source: "settlement-tx",
    txHash: r.txHash ?? null,
    ...(r.localId ? { localId: r.localId } : {}),
  };
}

function recordSettlementProof(action: string, vkId: WalletSettlementVk, r: SettleResult): void {
  appendWalletProofReceipt({
    action,
    vkId,
    prover: r.prover,
    verified: r.onChain && r.status === "settled",
    verifier: walletVerifierId(),
    txHash: r.txHash,
    publicInputs: settlementPublicInputsRef(r),
  });
}

function recordFailedMovement(sourceType: WalletLedgerSource, requestedAmount: string | undefined, e: unknown, dir: "in" | "out", sourceId?: string) {
  const safe = ledgerError(e, dir);
  appendWalletLedger({
    sourceType,
    sourceId,
    status: "failed",
    requestedAmount,
    lines: [],
    errorCode: safe.code,
    error: safe.error,
  });
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;
const routes: Array<{ method: string; path: string; handler: Handler }> = [];
const route = (method: string, path: string, handler: Handler) => routes.push({ method, path, handler });

route("GET", "/health", (_q, res) => json(res, 200, { ok: true }));

route("GET", "/api/auth/config", (_q, res) =>
  json(res, 200, { googleClientId: process.env.GOOGLE_CLIENT_ID ?? null, google: googleConfigured() }),
);

route("POST", "/api/auth/google", async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return json(res, 200, { verified: false, configured: false, note: "GOOGLE_CLIENT_ID not set" });
  try {
    const body = await readJson<{ credential: string; nonce?: string }>(req);
    const claims = await verifyGoogleIdToken(String(body.credential), clientId);
    if (body.nonce && claims.nonce && body.nonce !== claims.nonce) {
      return json(res, 400, { verified: false, error: "nonce mismatch (zkLogin binding)" });
    }
    json(res, 200, { verified: true, sub: claims.sub, iss: claims.iss, aud: claims.aud, email: claims.email, name: claims.name });
  } catch (e) {
    json(res, 401, { verified: false, error: (e as Error).message });
  }
});

function providedTestSecret(req: IncomingMessage, body: { secret?: string }): string {
  const h = req.headers["x-benzo-test-secret"];
  return (Array.isArray(h) ? h[0] : h) || body.secret || "";
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

route("POST", "/api/auth/test", async (req, res) => {
  const expected = hostedRuntime() ? process.env.BENZO_TEST_AUTH_SECRET : undefined;
  if (!expected) return json(res, 404, { error: "not found" });
  const body = await readJson<{ secret?: string; subject?: string; email?: string; name?: string; ttlSeconds?: number }>(req);
  if (!secretMatches(providedTestSecret(req, body), expected)) {
    return json(res, 401, { error: "test auth unavailable" });
  }
  const token = createTestAuthToken({
    subject: body.subject,
    email: body.email,
    name: body.name,
    ttlSeconds: body.ttlSeconds,
  });
  json(res, 200, { token, tokenType: "Bearer", expiresIn: Math.max(60, Math.min(body.ttlSeconds ?? 900, 3600)) });
});

route("GET", "/api/session", (_q, res) =>
  json(res, 200, { profile: db.profile, handle: db.profile.handle, kycTier: getKycTier(), ...liveStatus(), prover: proverInfo() }),
);

route("GET", "/api/recovery/status", (_q, res) =>
  json(res, 200, { status: "ok", recovery: recoverySummary() }),
);

route("GET", "/api/handle/available", async (_q, res, url) =>
  json(res, 200, { available: await handleAvailable(url.searchParams.get("h") ?? "") }),
);
route("POST", "/api/handle/claim", async (req, res) => {
  const body = await readJson<{ handle: string }>(req);
  if (!body.handle) return json(res, 400, { error: "handle required" });
  try {
    json(res, 200, await claimHandle(body.handle));
  } catch (e) {
    logRouteError("handle claim", e);
    json(res, 400, { error: "Handle could not be claimed. Please try another handle." });
  }
});
function appLiveStatus() {
  const s = liveStatus();
  const missing = [...new Set([...s.missing, ...tenantDataMissing()])];
  const live = s.live && missing.length === 0;
  return { ...s, live, mode: live ? "live" as const : "unavailable" as const, missing };
}

route("GET", "/api/live", (_q, res) => json(res, 200, appLiveStatus()));
route("GET", "/api/prover", (_q, res) => json(res, 200, { ...proverInfo(), live: isLive() }));

function takeLocalRateLimit(path: string, method: string): { ok: true } | { ok: false; retryAfter: number } {
  const write = method !== "GET";
  const key = write ? "write" : "read";
  const limit = write ? 40 : 180;
  const now = nowSec();
  const bucket = localRateLimits.get(key) ?? { windowStart: now, count: 0 };
  if (now - bucket.windowStart >= 60) {
    bucket.windowStart = now;
    bucket.count = 0;
  }
  bucket.count += path.startsWith("/api/relay") ? 4 : 1;
  localRateLimits.set(key, bucket);
  if (bucket.count > limit) return { ok: false, retryAfter: Math.max(1, 60 - (now - bucket.windowStart)) };
  return { ok: true };
}

async function rateLimit(path: string, method: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const write = method !== "GET";
  const bucketName = write ? "write" : "read";
  const limit = write ? 40 : 180;
  const weight = path.startsWith("/api/relay") ? 4 : 1;
  const tenantKey = currentWalletTenantKey();
  if (tenantKey) return takeTenantRateLimit("wallet", tenantKey, bucketName, weight, limit, 60);
  return takeLocalRateLimit(path, method);
}

function idempotencyHeader(req: IncomingMessage): string | null {
  const h = req.headers["idempotency-key"];
  const v = Array.isArray(h) ? h[0] : h;
  return v?.trim() || null;
}

function requiresIdempotency(method: string, path: string): boolean {
  if (!hostedRuntime()) return false;
  if (!path.startsWith("/api/")) return false;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  return path !== "/api/auth/google" && path !== "/api/auth/test";
}

async function runIdempotent(req: IncomingMessage, res: ServerResponse, path: string, fn: () => Promise<void>): Promise<void> {
  const method = req.method ?? "GET";
  const header = method === "GET" ? null : idempotencyHeader(req);
  if (!header) return fn();
  const raw = await rawBody(req);
  const bodyHash = createHash("sha256").update(raw).digest("hex");
  const key = `${method}:${path}:${header}`;
  db.idempotency ??= {};
  const existing = db.idempotency[key];
  if (existing) {
    if (existing.bodyHash !== bodyHash) return json(res, 409, { error: "Idempotency key was already used with a different request body." });
    return json(res, existing.status, existing.body);
  }
  await idempotencyScope.run({ key, bodyHash }, fn);
}

route("GET", "/api/balance", async (_q, res) => json(res, 200, await getBalanceStroops()));
route("GET", "/api/ramp/reserve", async (_q, res) => json(res, 200, await getRampReserve()));
route("GET", "/api/history", async (_q, res) => json(res, 200, await getActivity()));
route("GET", "/api/ledger", (_q, res) => json(res, 200, { entries: db.ledger ?? [], balances: walletLedgerBalances(), verify: verifyWalletLedger() }));
route("GET", "/api/ledger/verify", (_q, res) => json(res, 200, verifyWalletLedger()));
route("GET", "/api/proof-receipts", (_q, res) =>
  json(res, 200, [...(db.proofReceipts ?? [])].sort((a, b) => b.createdAt - a.createdAt)),
);

route("DELETE", "/api/account", async (_q, res) => {
  let privateBalance = 0n;
  let publicBalanceStroops = 0n;
  try {
    privateBalance = BigInt((await getBalanceStroops()).stroops);
    publicBalanceStroops = BigInt((await publicBalance()).stroops);
  } catch {
    return json(res, 409, {
      error: "Couldn't verify this wallet is empty. Move funds out, then try again.",
      blockers: ["balance_check_unavailable"],
    });
  }
  const pendingInvites = listInvites().filter((inv) => inv.status === "pending");
  const ledgerBalances = walletLedgerBalances();
  const claimEscrow = BigInt(ledgerBalances.claim_escrow ?? "0");
  const blockers: string[] = [];
  if (privateBalance > 0n) blockers.push("private_balance");
  if (publicBalanceStroops > 0n) blockers.push("public_balance");
  if (claimEscrow > 0n || pendingInvites.length > 0) blockers.push("pending_invites");
  if (blockers.length) {
    return json(res, 409, {
      error: "Move or refund all funds before deleting this Benzo account.",
      blockers,
      balances: {
        private: privateBalance.toString(),
        public: publicBalanceStroops.toString(),
        claimEscrow: claimEscrow.toString(),
      },
    });
  }
  await deleteCurrentWalletTenant();
  json(res, 200, { deleted: true });
});
// Contacts are device-local in the wallet UI; the hosted API never provides
// hosted people.
route("GET", "/api/contacts", (_q, res) => json(res, 200, []));

route("POST", "/api/send", async (req, res, url) => {
  const body = await readJson<{ to?: string; handle?: string; amount: string; memo?: string; prover?: string; requestId?: string }>(req);
  const to = body.to ?? body.handle; // `handle` kept for back-compat
  if (!to || !body.amount) return json(res, 400, { error: "to and amount required" });
  if (malformedHandle(to)) {
    const error = "Handles are 3 to 20 characters: letters, numbers, dots, or underscores.";
    if ((req.headers.accept ?? "").includes("text/event-stream")) {
      cors(res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: phase\ndata: ${JSON.stringify({ phase: "failed", error })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ status: "failed", prover: "tee", amount: "0", onChain: false, error })}\n\n`);
      res.end();
      return;
    }
    return json(res, 400, { error });
  }
  const prover = proverOf(url, body);

  // Stream the 3-phase ceremony when the client asks for it (fetch + reader, not
  // EventSource, so a POST body works). Otherwise fall back to a single JSON reply
  // (keeps non-streaming callers compatible).
  if ((req.headers.accept ?? "").includes("text/event-stream")) {
    cors(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const emit = (e: SendPhase) => res.write(`event: phase\ndata: ${JSON.stringify(e)}\n\n`);
    try {
      const r = await send(to, body.amount, body.memo, prover, body.requestId, emit);
      recordSettledMovement(classifyRecipient(to) === "address" ? "send_public" : "send_private", r.amount, { txHash: r.txHash, prover: r.prover, sourceId: body.requestId, requestedAmount: body.amount });
      recordSettlementProof(classifyRecipient(to) === "address" ? "wallet.send-public-from-private" : "wallet.send-private", classifyRecipient(to) === "address" ? "UNSHIELD" : "TRANSFER", r);
      rememberIdempotency(200, r);
      res.write(`event: done\ndata: ${JSON.stringify(r)}\n\n`);
    } catch (e) {
      logRouteError("send stream", e);
      const safe = sendError(e);
      recordFailedMovement(classifyRecipient(to) === "address" ? "send_public" : "send_private", body.amount, e, "out");
      const amount =
        Number.isFinite(Number(body.amount)) && Number(body.amount) > 0
          ? String(BigInt(Math.round(Number(body.amount) * 10_000_000)))
          : "0";
      const failed: SettleResult = { status: "failed", prover, amount, onChain: false, error: safe.error };
      res.write(`event: phase\ndata: ${JSON.stringify({ phase: "failed", error: safe.error })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify(failed)}\n\n`);
    }
    res.end();
    return;
  }
  try {
    const r = await send(to, body.amount, body.memo, prover, body.requestId);
    recordSettledMovement(classifyRecipient(to) === "address" ? "send_public" : "send_private", r.amount, { txHash: r.txHash, prover: r.prover, sourceId: body.requestId, requestedAmount: body.amount });
    recordSettlementProof(classifyRecipient(to) === "address" ? "wallet.send-public-from-private" : "wallet.send-private", classifyRecipient(to) === "address" ? "UNSHIELD" : "TRANSFER", r);
    json(res, 200, r);
  } catch (e) {
    recordFailedMovement(classifyRecipient(to) === "address" ? "send_public" : "send_private", body.amount, e, "out");
    json(res, rampStatus(e), sendError(e));
  }
});

route("POST", "/api/request", async (req, res) => {
  const body = await readJson<{ amount?: string; memo?: string }>(req);
  json(res, 200, await createRequest(body.amount, body.memo));
});

route("GET", "/api/request/status", async (_req, res, url) => {
  const id = url.searchParams.get("id")?.trim();
  if (!id) return json(res, 400, { error: "request id required" });
  json(res, 200, await getMoneyRequestStatus(id));
});

route("POST", "/api/request/reconcile", async (req, res) => {
  const body = await readJson<{ id?: string }>(req);
  if (!body.id) return json(res, 400, { error: "request id required" });
  try {
    json(res, 200, await reconcileMoneyRequest(body.id));
  } catch (e) {
    logRouteError("request reconcile", e);
    json(res, 503, { error: "Couldn't verify this request payment yet. Please try again." });
  }
});

route("POST", "/api/request/cancel", async (req, res) => {
  const body = await readJson<{ id?: string }>(req);
  if (!body.id) return json(res, 400, { error: "request id required" });
  try {
    json(res, 200, await cancelMoneyRequest(body.id));
  } catch (e) {
    logRouteError("request cancel", e);
    json(res, 503, { error: (e as Error).message || "Couldn't cancel the request. Please try again." });
  }
});

// external invite / claim (send to / claim from someone with no account)
route("GET", "/api/invites", (_q, res) => json(res, 200, listInvites()));
route("POST", "/api/invite", async (req, res) => {
  const body = await readJson<{ amount: string; note?: string }>(req);
  if (!body.amount) return json(res, 400, { error: "amount required" });
  try {
    const r = await createInvite(body.amount, body.note);
    recordSettledMovement("invite_fund", r.amount, { sourceId: r.localId, requestedAmount: body.amount });
    appendWalletProofReceipt({
      action: "wallet.invite-fund",
      vkId: "TRANSFER",
      verified: r.onChain,
      verifier: walletVerifierId(),
      txHash: r.txHash,
      publicInputs: proofPublicInputsRef(r),
    });
    json(res, 201, r);
  } catch (e) {
    logRouteError("invite fund", e);
    recordFailedMovement("invite_fund", body.amount, e, "out");
    json(res, rampStatus(e), rampError(e, "out"));
  }
});
route("POST", "/api/invite/refund", async (req, res) => {
  const body = await readJson<{ localId: string }>(req);
  if (!body.localId) return json(res, 400, { error: "localId required" });
  try {
    const r = await refundInvite(body.localId);
    recordSettledMovement("invite_refund", r.amount, { txHash: r.txHash, sourceId: body.localId });
    appendWalletProofReceipt({
      action: "wallet.invite-refund",
      vkId: "SHIELD",
      verified: r.onChain,
      verifier: walletVerifierId(),
      txHash: r.txHash,
      publicInputs: proofPublicInputsRef(r),
    });
    json(res, 200, r);
  } catch (e) {
    recordFailedMovement("invite_refund", undefined, e, "in", body.localId);
    json(res, 400, { error: "Could not refund this invite. It may already be claimed or expired." });
  }
});
route("POST", "/api/claim", async (req, res) => {
  const body = await readJson<{ secret: string; localId?: string; amount?: string }>(req);
  if (!body.secret) return json(res, 400, { error: "secret required" });
  try {
    const r = await claimInvite(body.secret, body.localId, body.amount);
    recordSettledMovement("invite_claim", r.amount, { txHash: r.txHash, sourceId: body.localId });
    appendWalletProofReceipt({
      action: "wallet.invite-claim",
      vkId: "SHIELD",
      verified: r.onChain,
      verifier: walletVerifierId(),
      txHash: r.txHash,
      publicInputs: proofPublicInputsRef(r),
    });
    json(res, 200, r);
  } catch (e) {
    recordFailedMovement("invite_claim", undefined, e, "in", body.localId);
    json(res, 400, { error: "Could not claim this invite. Check the link and try again." });
  }
});

route("POST", "/api/cash-out", async (req, res, url) => {
  const body = await readJson<{ amount: string; prover?: string }>(req);
  if (!body.amount) return json(res, 400, { error: "amount required" });
  try {
    const r = await cashOut(body.amount, proverOf(url, body));
    recordSettledMovement("offramp", r.amount, { txHash: r.txHash, prover: r.prover, requestedAmount: body.amount });
    recordSettlementProof("wallet.cash-out", "UNSHIELD", r);
    json(res, 200, r);
  } catch (e) {
    logRouteError("cash-out", e);
    recordFailedMovement("offramp", body.amount, e, "out");
    json(res, rampStatus(e), rampError(e, "out"));
  }
});

route("POST", "/api/add-money", async (req, res, url) => {
  const body = await readJson<{ amount: string; prover?: string }>(req);
  if (!body.amount) return json(res, 400, { error: "amount required" });
  try {
    const r = await addMoney(body.amount, proverOf(url, body));
    recordSettledMovement("onramp", r.amount, { txHash: r.txHash, prover: r.prover, requestedAmount: body.amount });
    recordSettlementProof("wallet.add-money", "SHIELD", r);
    json(res, 200, r);
  } catch (e) {
    logRouteError("add-money", e);
    recordFailedMovement("onramp", body.amount, e, "in");
    json(res, rampStatus(e), rampError(e, "in"));
  }
});

// Direct deposit / import USDC from any external wallet (no ramp, no bank).
route("GET", "/api/deposit-address", async (_q, res) => {
  try {
    json(res, 200, await getDepositInfo());
  } catch {
    json(res, 503, { error: "Couldn't load your deposit address yet. Please try again.", code: "deposit_unavailable" });
  }
});
route("POST", "/api/import", async (req, res, url) => {
  const body = await readJson<{ amount?: string; prover?: string }>(req);
  try {
    const r = await importDeposit(body.amount, proverOf(url, body));
    recordSettledMovement("import", r.amount, { txHash: r.txHash, prover: r.prover, requestedAmount: body.amount ?? "all" });
    recordSettlementProof("wallet.import", "SHIELD", r);
    json(res, 200, r);
  } catch (e) {
    recordFailedMovement("import", body.amount ?? "all", e, "in");
    json(res, rampStatus(e), rampError(e, "in"));
  }
});

// Two-balance model: the "Public" balance (plain liquid USDC on the account) +
// "Make public" (unshield pool → public) + "Send to a wallet" (public → any
// external G-address). ("Make private" = POST /api/import; "Receive" = GET
// /api/deposit-address — already defined above.)
route("GET", "/api/public-balance", async (_q, res) => {
  try {
    json(res, 200, await publicBalance());
  } catch {
    json(res, 503, { error: "Couldn't load your Public balance yet. Please try again.", code: "public_balance_unavailable" });
  }
});
route("POST", "/api/make-public", async (req, res, url) => {
  const body = await readJson<{ amount: string; prover?: string }>(req);
  if (!body.amount) return json(res, 400, { error: "amount required" });
  try {
    const r = await makePublic(body.amount, proverOf(url, body));
    recordSettledMovement("make_public", r.amount, { txHash: r.txHash, prover: r.prover, requestedAmount: body.amount });
    recordSettlementProof("wallet.make-public", "UNSHIELD", r);
    json(res, 200, r);
  } catch (e) {
    recordFailedMovement("make_public", body.amount, e, "out");
    json(res, rampStatus(e), rampError(e, "out"));
  }
});
route("POST", "/api/send-public", async (req, res) => {
  const body = await readJson<{ to: string; amount: string }>(req);
  if (!body.to || !body.amount) return json(res, 400, { error: "to and amount required" });
  try {
    const r = await sendPublic(body.to, body.amount);
    recordSettledMovement("send_public", r.amount, { txHash: r.txHash, requestedAmount: body.amount });
    json(res, 200, r);
  } catch (e) {
    recordFailedMovement("send_public", body.amount, e, "out");
    json(res, rampStatus(e), rampError(e, "out"));
  }
});

route("POST", "/api/share-proof", async (req, res, url) => {
  const body = await readJson<{ min: string; prover?: string }>(req);
  if (!body.min) return json(res, 400, { error: "min required" });
  const receipt = await shareProof(body.min, proverOf(url, body));
  appendWalletProofReceipt({
    action: "wallet.share-proof",
    vkId: "BALANCE",
    prover: receipt.prover,
    verified: receipt.onChain,
    verifier: walletVerifierId(),
    publicInputs: receipt.publics,
  });
  json(res, 200, receipt);
});

// LOCAL TESTNET-DEV ONLY (BENZO_DEV_EXPORT=1): provision the account to a
// localhost device so the browser reads its shielded balance/history straight
// from chain (no BFF). Hosted deployments must never export account material.
route("GET", "/api/dev/account", (_q, res) => {
  const acct = exportAccountForDevice();
  if (!acct) {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  json(res, 200, acct);
});

// Stateless gas-paying relay for client-side WRITES: the browser proves the
// transfer on-device and hands over only the proof + public inputs to submit.
route("POST", "/api/relay/submit", async (req, res) => {
  const body = await readJson<{ contractId: string; fnArgs: string[] }>(req);
  try {
    json(res, 200, await relaySubmit(body.contractId, body.fnArgs));
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const rpcPath = url.pathname === "/api/rpc" ? url.searchParams.get("path") : null;
  const effectiveUrl = rpcPath?.startsWith("/") && !rpcPath.startsWith("//")
    ? new URL(`/api${rpcPath}`, `http://localhost:${PORT}`)
    : url;
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const r = routes.find((x) => x.method === (req.method ?? "GET") && x.path === effectiveUrl.pathname);
    if (!r) return json(res, 404, { error: "not found" });
    const publicHosted =
      effectiveUrl.pathname === "/api/live" ||
      effectiveUrl.pathname === "/api/prover" ||
      effectiveUrl.pathname === "/api/auth/config" ||
      effectiveUrl.pathname === "/api/auth/google" ||
      effectiveUrl.pathname === "/api/auth/test";
    let auth: Awaited<ReturnType<typeof authFromRequest>> = null;
    if (hostedRuntime()) {
      try {
        auth = await authFromRequest(req);
      } catch (e) {
        return json(res, 401, { error: (e as Error).message, live: false, mode: "unavailable", missing: [] });
      }
      if (!auth && effectiveUrl.pathname.startsWith("/api/") && !publicHosted) {
        return json(res, 401, { error: "Sign in with Google to unlock this wallet.", live: false, mode: "unavailable", missing: [] });
      }
    }
    if (requiresIdempotency(req.method ?? "GET", effectiveUrl.pathname) && !idempotencyHeader(req)) {
      return json(res, 428, { error: "Idempotency-Key header is required for hosted wallet writes." });
    }
    const persistTenant = !["GET", "HEAD", "OPTIONS"].includes((req.method ?? "GET").toUpperCase());
    await runWithAuth(auth, async () => {
      await runWithWalletTenant(auth?.key ?? null, auth?.claims ?? null, auth ? accountBinding(auth) : null, async () => {
        if (effectiveUrl.pathname.startsWith("/api/") && !publicHosted && (!isLive() || tenantDataMissing().length > 0)) {
          return json(res, 503, {
            error: "Live testnet client unavailable. Refusing to serve app data.",
            ...appLiveStatus(),
          });
        }
        if (effectiveUrl.pathname.startsWith("/api/") && !publicHosted) {
          const rl = await rateLimit(effectiveUrl.pathname, req.method ?? "GET");
          if (!rl.ok) return json(res, 429, { error: "Too many requests. Please wait a moment and try again.", retryAfter: rl.retryAfter });
        }
        await runIdempotent(req, res, effectiveUrl.pathname, () => Promise.resolve(r.handler(req, res, effectiveUrl)));
      }, { persist: persistTenant });
    });
  } catch (e) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      logRouteError("post-response handler error", e);
      return;
    }
    if (e instanceof HostedLocalProverError) {
      return json(res, 400, { error: e.message, code: e.code });
    }
    if (e instanceof RecoveryRequiredError) {
      return json(res, 409, {
        error: e.message,
        code: e.code,
        recovery: {
          status: "required",
          reason: e.code,
        },
      });
    }
    json(res, 500, { error: "Server unavailable. Please try again.", live: false, mode: "unavailable" });
  }
}

export default handle;

const server = createServer(handle);

if (!serverlessRuntime()) server.listen(PORT, () => {
  const s = liveStatus();
  console.error(`[benzo-wallet-api] listening on :${PORT}`);
  if (s.live) {
    console.error("[benzo-wallet-api] MODE=LIVE — REAL on-chain shielded USDC via @benzo/core (testnet).");
  } else {
    console.error(
      `[benzo-wallet-api] MODE=UNAVAILABLE — refusing app data. ` +
        `Missing: ${s.missing.join(", ") || "(client init failed)"}. To go live: set -a; . ./.env; set +a; restart.`,
    );
  }
});
