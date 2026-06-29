/**
 * Contacts (C6 - Wise/Cash recipient management). Local-first: the BFF supplies
 * recent contacts, and THIS module adds device-local saved contacts + nicknames
 * in localStorage. Used to surface saved recipients on Send and to power the
 * first-time-recipient nudge (C11) / approved-contacts.
 */
import type { Contact } from "./api";

const LS = "benzo.contacts.local.v1";

/** Normalize to a leading-@ handle so "alice" and "@alice" are the same key. */
export function normHandle(h: string): string {
  const t = h.trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9_.]{3,20}$/.test(t) ? `@${t}` : "";
}

export function listLocal(): Contact[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || "[]");
    return Array.isArray(raw) ? raw.filter((c) => c && c.handle) : [];
  } catch {
    return [];
  }
}

function writeLocal(cs: Contact[]): void {
  try {
    localStorage.setItem(LS, JSON.stringify(cs));
  } catch {
    /* ignore */
  }
}

/** Add or update (by handle) a saved contact. Returns the new local list. */
export function saveContact(handle: string, name: string): Contact[] {
  const h = normHandle(handle);
  if (!h) return listLocal();
  const cs = listLocal().filter((c) => normHandle(c.handle) !== h);
  cs.unshift({ handle: h, name: name.trim() || h });
  writeLocal(cs);
  return cs;
}

export function removeContact(handle: string): Contact[] {
  const h = normHandle(handle);
  const cs = listLocal().filter((c) => normHandle(c.handle) !== h);
  writeLocal(cs);
  return cs;
}

export function isSaved(handle: string): boolean {
  const h = normHandle(handle);
  return listLocal().some((c) => normHandle(c.handle) === h);
}

/**
 * Merge BFF contacts with local ones, de-duped by handle. Local nicknames win
 * (so a saved nickname overrides the BFF display name).
 */
export function mergeContacts(bff: Contact[]): Contact[] {
  const local = listLocal();
  const byHandle = new Map<string, Contact>();
  for (const c of bff) byHandle.set(normHandle(c.handle), { ...c, handle: normHandle(c.handle) });
  for (const c of local) byHandle.set(normHandle(c.handle), c); // local overrides
  return [...byHandle.values()];
}
