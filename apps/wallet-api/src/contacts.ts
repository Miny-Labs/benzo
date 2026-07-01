import type { Contact, WalletDb } from "./store.js";

function normHandle(handle: string | undefined): string {
  const raw = (handle ?? "").trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9_.]{3,20}$/.test(raw) ? `@${raw}` : "";
}

function upsert(map: Map<string, Contact>, contact: Contact): void {
  const handle = normHandle(contact.handle);
  if (!handle) return;
  map.set(handle, {
    handle,
    name: contact.name?.trim() || handle,
    tone: contact.tone,
  });
}

export function walletContactsFromDb(db: WalletDb): Contact[] {
  const byHandle = new Map<string, Contact>();
  const recentLedger = [...(db.ledger ?? [])]
    .filter((entry) => entry.status === "settled")
    .sort((a, b) => b.postedAt - a.postedAt);

  for (const entry of recentLedger) {
    const handle = normHandle(entry.counterparty);
    if (!handle || byHandle.has(handle)) continue;
    upsert(byHandle, { handle, name: handle, tone: entry.sourceType === "send_private" ? "accent" : "neutral" });
  }

  for (const row of [...(db.activity ?? [])].sort((a, b) => b.timestamp - a.timestamp)) {
    const handle = normHandle(row.name);
    if (!handle || byHandle.has(handle)) continue;
    upsert(byHandle, { handle, name: handle, tone: row.tone ?? "accent" });
  }

  for (const saved of db.contacts ?? []) {
    upsert(byHandle, saved);
  }

  return [...byHandle.values()].slice(0, 20);
}
