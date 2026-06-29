/**
 * Money requests (C7 - Venmo/Wise parity, privacy-adapted). The requester's
 * tracked requests live ON DEVICE (localStorage), like notifications - there is
 * NO public/global request feed and no server keyed to a payer identity. A
 * request is paid only when the requester's own wallet observes the incoming
 * note; here we track the requester's view + the local lifecycle.
 *
 * Canonical 30-day expiry mirrors Venmo/Wise. Reminders are local (re-share the
 * link), never a server push that would leak the requester→payer edge.
 */
const LS = "benzo.requests.v1";
const THIRTY_DAYS = 30 * 24 * 3600;

export type RequestStatus = "pending" | "partially_paid" | "paid" | "declined" | "expired" | "cancelled";

export interface MoneyRequest {
  id: string;
  link: string;
  amount?: string; // stroops; omit = "any amount"
  memo?: string;
  to?: string; // bound payer @handle, or undefined = open invoice
  createdAt: number; // unix seconds
  expiresAt: number;
  status: RequestStatus;
  paidAmount?: string;
  lastRemindedAt?: number;
}

export function listRequests(now: number = nowS()): MoneyRequest[] {
  let raw: MoneyRequest[];
  try {
    raw = JSON.parse(localStorage.getItem(LS) || "[]");
  } catch {
    raw = [];
  }
  // Flip pending → expired past the deadline (derived, not stored eagerly).
  return raw
    .map((r) => (r.status === "pending" && now >= r.expiresAt ? { ...r, status: "expired" as RequestStatus } : r))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function findRequest(id: string, now: number = nowS()): MoneyRequest | null {
  return listRequests(now).find((r) => r.id === id) ?? null;
}

function write(rs: MoneyRequest[]): void {
  try {
    localStorage.setItem(LS, JSON.stringify(rs));
  } catch {
    /* ignore */
  }
}

export function addRequest(
  r: { id: string; link: string; amount?: string; memo?: string; to?: string },
  createdAt: number = nowS(),
): MoneyRequest {
  const rec: MoneyRequest = {
    ...r,
    createdAt,
    expiresAt: createdAt + THIRTY_DAYS,
    status: "pending",
  };
  write([rec, ...listRequests().filter((x) => x.id !== r.id)]);
  return rec;
}

function patch(id: string, fields: Partial<MoneyRequest>): void {
  write(listRequests().map((r) => (r.id === id ? { ...r, ...fields } : r)));
}

export function cancelRequest(id: string): void {
  patch(id, { status: "cancelled" });
}

/** Local "remind" - the caller re-shares the link; we just record the timestamp. */
export function markReminded(id: string, at: number = nowS()): void {
  patch(id, { lastRemindedAt: at });
}

export function markPaid(id: string, paidAmount?: string): void {
  patch(id, { status: "paid", paidAmount });
}

export function updateRequestStatus(id: string, status: RequestStatus, paidAmount?: string): void {
  patch(id, { status, paidAmount });
}

/** Reminders are rate-limited to once/day in the UI (Venmo's manual-nudge pattern). */
export function remindedToday(r: MoneyRequest, now: number = nowS()): boolean {
  return !!r.lastRemindedAt && now - r.lastRemindedAt < 24 * 3600;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}
