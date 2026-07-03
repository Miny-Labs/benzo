const LS = "benzo.invites.local.v2";
const THIRTY_DAYS = 30 * 24 * 3600;

export interface LocalInvite {
  localId: string;
  amount: string; // stroops
  note?: string;
  status: "pending" | "claimed" | "refunded" | "expired";
  createdAt: number; // unix seconds
  expiresAt: number;
  claimSecretHex: string;
  link: string;
}

export function listLocalInvites(now: number = nowS()): LocalInvite[] {
  let raw: LocalInvite[];
  try {
    raw = JSON.parse(localStorage.getItem(LS) || "[]");
  } catch {
    raw = [];
  }
  return raw
    .map((r) => (r.status === "pending" && now >= r.expiresAt ? { ...r, status: "expired" as const } : r))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function write(is: LocalInvite[]): void {
  try {
    localStorage.setItem(LS, JSON.stringify(is));
  } catch {
    /* ignore */
  }
}

export function addLocalInvite(
  inv: { localId: string; amount: string; note?: string; claimSecretHex: string; link: string },
  createdAt: number = nowS(),
): LocalInvite {
  const rec: LocalInvite = {
    ...inv,
    createdAt,
    expiresAt: createdAt + THIRTY_DAYS,
    status: "pending",
  };
  write([rec, ...listLocalInvites().filter((x) => x.localId !== inv.localId)]);
  return rec;
}

export function updateLocalInviteStatus(localId: string, status: LocalInvite["status"]): void {
  write(listLocalInvites().map((inv) => (inv.localId === localId ? { ...inv, status } : inv)));
}

export function clearLocalInvites(): void {
  localStorage.removeItem(LS);
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}
