/**
 * Typed client for @benzo/wallet-api. Same-origin "/api" (Vite proxies to :8791).
 * The UI talks ONLY to this — never to the chain directly — so a screen renders
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
  /** legacy local row, not a real on-chain settlement — the UI badges it. */
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

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiHref(path), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
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
}

export const api = {
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
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(args),
    });
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream")) {
      // BFF declined to stream (or errored) → treat as a single JSON reply.
      const body = (await res.json()) as SettleResult & { error?: string };
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
