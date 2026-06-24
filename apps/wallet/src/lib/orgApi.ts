/**
 * orgApi (P0-B3) — the ONE place the consumer wallet talks to a business's
 * console-api: a contractor accepting an org invite and billing that org. This is
 * a deliberate cross-product interaction (a contractor submitting an invoice to a
 * company), NOT identity sharing — the contractor keeps their own wallet identity;
 * the org just gets an invoice tied to the contractor's @handle. Defaults to the
 * local console-api; override with VITE_CONSOLE_ORIGIN.
 */
function defaultOrgBase(): string {
  if (typeof window === "undefined") return "http://localhost:8790";
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" ? "http://localhost:8790" : "https://console.benzo.space";
}

const ORG_BASE = ((import.meta as { env?: Record<string, string> }).env?.VITE_CONSOLE_ORIGIN) || defaultOrgBase();

async function ohttp<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ORG_BASE}/api/rpc?path=${encodeURIComponent(path)}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) detail = b.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export interface AcceptedInvite {
  ok: boolean;
  orgName: string;
  kind: "member" | "contractor" | "customer";
  counterpartyId?: string;
  orgId?: string;
}
export interface OrgInvoice {
  id: string;
  number: string;
  counterpartyId: string;
  total: { amount: string; assetCode: string };
  status: "draft" | "open" | "paid" | "void" | "cancelled";
  lineItems: Array<{ description: string; quantity: number; unitAmount: string }>;
}

function toStroops(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "0";
  return BigInt(Math.round(n * 1e7)).toString();
}

export const orgApi = {
  acceptInvite: (body: { token: string; handle?: string; counterpartyId?: string; kind?: "member" | "contractor" | "customer"; orgId?: string; name?: string }) =>
    ohttp<AcceptedInvite>("/invites/accept", { method: "POST", body: JSON.stringify(body) }),
  submitInvoice: (counterpartyId: string, amount: string, description: string) =>
    ohttp<OrgInvoice>("/invoices", {
      method: "POST",
      body: JSON.stringify({
        counterpartyId,
        lineItems: [{ description, quantity: 1, unitAmount: toStroops(amount) }],
        assetCode: "USDC",
      }),
    }),
  invoices: () => ohttp<OrgInvoice[]>("/invoices"),
};
