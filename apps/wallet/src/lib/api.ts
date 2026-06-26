/**
 * Typed client for @benzo/wallet-api. Same-origin "/api" (Vite proxies to :8791).
 * The UI talks ONLY to this - never to the chain directly - so a screen renders
 * dollars + plain-English status and never touches stroops/proofs/tx plumbing.
 */
export type ProverKind = "local" | "tee";

export interface Session {
  profile: { handle: string; name: string };
  handle?: string;
  kycTier?: number;
  live: boolean;
  mode: "live" | "unavailable";
  missing: string[];
  prover: { available: ProverKind[]; tee: { endpoint: string; measurement: string } | null };
}
export interface Balance {
  stroops: string;
  live: boolean;
}
export interface ActivityRow {
  id: string;
  type: string;
  name: string;
  note: string;
  amount: string;
  direction: "in" | "out";
  status: "settled" | "pending" | "proving" | "arriving" | "failed";
  timestamp: number;
  txHash?: string;
  tone?: "accent" | "amber" | "neutral";
  /** legacy local row, not a real on-chain settlement - the UI badges it. */
  unverified?: boolean;
}
export interface Contact {
  handle: string;
  name: string;
  tone?: "accent" | "amber" | "neutral";
}
export interface SettleResult {
  status: "settled" | "failed";
  txHash?: string;
  provingMs?: number;
  prover: ProverKind;
  amount: string;
  onChain: boolean;
  error?: string;
}

export interface SendPhaseEvent {
  phase: "building" | "proving" | "submitting" | "confirmed" | "failed";
  provingMs?: number;
  txHash?: string;
  onChain?: boolean;
  error?: string;
}

export interface InviteResult {
  link: string;
  localId: string;
  claimAccountPub: string;
  amount: string;
  expiresAt: number;
  onChain: boolean;
}
export interface InviteSummary {
  localId: string;
  amount: string;
  note?: string;
  link: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "claimed" | "refunded" | "expired";
}

export function apiHref(path: string): string {
  return `/api/rpc?path=${encodeURIComponent(path)}`;
}

const GOOGLE_TOKEN_KEY = "benzo.googleCredential";
const GOOGLE_IDENTITY_KEY = "benzo.identityKey";
const IDEMPOTENCY_PREFIX = "benzo.idempotency.wallet.v1:";

function b64urlJson(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(seg.length / 4) * 4, "="))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function identityKeyFromCredential(credential: string): string {
  const parts = credential.split(".");
  const payload = parts.length === 3 ? b64urlJson(parts[1]) : null;
  const iss = typeof payload?.iss === "string" ? payload.iss : "unknown";
  const aud = typeof payload?.aud === "string" ? payload.aud : "unknown";
  const sub = typeof payload?.sub === "string" ? payload.sub : "unknown";
  let h = 0x811c9dc5;
  for (const ch of `wallet|${iss}|${aud}|${sub}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return `g${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function storeGoogleCredential(credential: string): void {
  const nextIdentity = identityKeyFromCredential(credential);
  const prevIdentity = localStorage.getItem(GOOGLE_IDENTITY_KEY);
  if (prevIdentity && prevIdentity !== nextIdentity) {
    for (const key of [
      "benzo.onboarded",
      "benzo.contacts.local.v1",
      "benzo.requests.v1",
      "benzo.notif.read.v1",
      "benzo.hidden",
    ]) localStorage.removeItem(key);
  }
  localStorage.setItem(GOOGLE_IDENTITY_KEY, nextIdentity);
  localStorage.setItem(GOOGLE_TOKEN_KEY, credential);
}

export function clearGoogleCredential(): void {
  localStorage.removeItem(GOOGLE_TOKEN_KEY);
  localStorage.removeItem(GOOGLE_IDENTITY_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function randomIdempotencyKey(): string {
  const uuid = crypto.randomUUID?.();
  if (uuid) return `idem_${uuid}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `idem_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function idempotencyKey(path: string, init?: RequestInit): { key: string; clear: () => void } | null {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const body = typeof init?.body === "string" ? init.body : "";
  const storageKey = `${IDEMPOTENCY_PREFIX}${shortHash(`${method}:${path}:${body}`)}`;
  let key = localStorage.getItem(storageKey);
  if (!key) {
    key = randomIdempotencyKey();
    localStorage.setItem(storageKey, key);
  }
  return { key, clear: () => localStorage.removeItem(storageKey) };
}

export function prepareApiRequest(path: string, init?: RequestInit): { url: string; init: RequestInit; clearIdempotency?: () => void } {
  const headers = new Headers(init?.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
  const idem = idempotencyKey(path, init);
  if (idem) headers.set("Idempotency-Key", idem.key);
  return {
    url: apiHref(path),
    init: { ...init, headers },
    clearIdempotency: idem?.clear,
  };
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const prepared = prepareApiRequest(path, init);
  let res: Response | undefined;
  try {
    res = await fetch(prepared.url, prepared.init);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  } finally {
    if (res && res.status < 500) prepared.clearIdempotency?.();
  }
}

export const api = {
  authConfig: () => http<{ googleClientId: string | null; google: boolean }>("/auth/config"),
  googleVerify: (credential: string, nonce?: string) =>
    http<{ verified: boolean; sub?: string; email?: string; name?: string; error?: string; configured?: boolean }>(
      "/auth/google",
      { method: "POST", body: JSON.stringify({ credential, nonce }) },
    ),
  session: () => http<Session>("/session"),
  balance: () => http<Balance>("/balance"),
  rampReserve: () => http<{ reserve: string | null; live: boolean }>("/ramp/reserve"),
  depositInfo: () => http<{ address: string | null; liquid: string; asset: string; issuer: string; live: boolean }>("/deposit-address"),
  importDeposit: (amount?: string, prover: ProverKind = "tee") =>
    http<SettleResult>("/import", { method: "POST", body: JSON.stringify({ amount, prover }) }),
  /** The "Public" balance: plain liquid USDC on the account (send to/receive from any wallet). */
  publicBalance: () =>
    http<{ stroops: string; address: string; asset: string; issuer: string; live: boolean }>("/public-balance"),
  /** "Make public": unshield from the private pool back to your own public balance. */
  makePublic: (amount: string, prover: ProverKind = "tee") =>
    http<SettleResult>("/make-public", { method: "POST", body: JSON.stringify({ amount, prover }) }),
  /** "Send to a wallet": pay any external Stellar G-address from the Public balance. */
  sendPublic: (to: string, amount: string) =>
    http<{ txHash?: string; onChain: boolean }>("/send-public", { method: "POST", body: JSON.stringify({ to, amount }) }),
  history: () => http<ActivityRow[]>("/history"),
  contacts: () => http<Contact[]>("/contacts"),
  send: (to: string, amount: string, memo?: string, prover: ProverKind = "tee") =>
    http<SettleResult>("/send", { method: "POST", body: JSON.stringify({ to, amount, memo, prover }) }),
  /** Streaming send: drives the 3-phase ceremony via SSE-over-fetch (POST). */
  sendStream: async (
    args: { to: string; amount: string; memo?: string; prover?: ProverKind },
    onPhase: (e: SendPhaseEvent) => void,
  ): Promise<SettleResult> => {
    const prepared = prepareApiRequest("/send", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify(args),
    });
    const res = await fetch(prepared.url, prepared.init);
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream")) {
      // BFF declined to stream (or errored) → treat as a single JSON reply.
      const body = (await res.json()) as SettleResult & { error?: string };
      if (res.status < 500) prepared.clearIdempotency?.();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let final: SettleResult | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        let ev = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        if (ev === "phase") onPhase(JSON.parse(data) as SendPhaseEvent);
        else if (ev === "done") final = JSON.parse(data) as SettleResult;
      }
    }
    if (!final) throw new Error("send did not complete");
    prepared.clearIdempotency?.();
    return final;
  },
  handleAvailable: (h: string) =>
    http<{ available: boolean }>(`/handle/available?h=${encodeURIComponent(h)}`),
  claimHandle: (handle: string) =>
    http<{ handle: string; txHash?: string; onChain: boolean }>("/handle/claim", {
      method: "POST",
      body: JSON.stringify({ handle }),
    }),
  request: (amount?: string, memo?: string) =>
    http<{ link: string; id: string }>("/request", { method: "POST", body: JSON.stringify({ amount, memo }) }),
  invite: (amount: string, note?: string) =>
    http<InviteResult>("/invite", { method: "POST", body: JSON.stringify({ amount, note }) }),
  invites: () => http<InviteSummary[]>("/invites"),
  refundInvite: (localId: string) =>
    http<{ amount: string; txHash?: string; onChain: boolean }>("/invite/refund", { method: "POST", body: JSON.stringify({ localId }) }),
  claim: (secret: string, localId?: string) =>
    http<{ amount: string; txHash?: string; onChain: boolean }>("/claim", { method: "POST", body: JSON.stringify({ secret, localId }) }),
  cashOut: (amount: string, prover: ProverKind = "tee") =>
    http<SettleResult>("/cash-out", { method: "POST", body: JSON.stringify({ amount, prover }) }),
  addMoney: (amount: string, prover: ProverKind = "tee") =>
    http<SettleResult>("/add-money", { method: "POST", body: JSON.stringify({ amount, prover }) }),
  shareProof: (min: string, prover: ProverKind = "tee") =>
    http<{ holds: boolean; proof: string; publics: string[]; onChain: boolean; prover: ProverKind }>("/share-proof", {
      method: "POST",
      body: JSON.stringify({ min, prover }),
    }),
};
