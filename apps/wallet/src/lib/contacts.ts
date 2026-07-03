import { type Contact } from "./api";
import { decodeRecipient } from "./recipient";

const LS = "benzo.contacts.local.v1";

export function normAddress(a: string): string {
  const t = a.trim();
  if (/^G[A-Z2-7]{55}$/.test(t)) return t;
  if (t.startsWith("bzr_") && decodeRecipient(t) !== null) return t;
  return "";
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

export function saveContact(address: string, name: string): Contact[] {
  const addr = normAddress(address);
  if (!addr) return listLocal();
  const cs = listLocal().filter((c) => c.handle !== addr);
  cs.unshift({ handle: addr, name: name.trim() || addr });
  writeLocal(cs);
  return cs;
}

export function removeContact(address: string): Contact[] {
  const addr = normAddress(address);
  const cs = listLocal().filter((c) => c.handle !== addr);
  writeLocal(cs);
  return cs;
}

export function isSaved(address: string): boolean {
  const addr = normAddress(address);
  return listLocal().some((c) => c.handle === addr);
}

export function mergeContacts(bff: Contact[]): Contact[] {
  return listLocal();
}
