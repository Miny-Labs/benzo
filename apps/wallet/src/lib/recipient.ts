import { isValidStellarAddress } from "./strkey";

export type RecipientKind = "handle" | "address" | "invite";

export function looksLikeStellarAddressInput(to: string): boolean {
  const t = to.trim();
  return /^G[A-Z2-7]+$/.test(t) && t.length > 20;
}

export function isValidHandleRecipient(to: string): boolean {
  const t = to.trim().replace(/^@/, "");
  return /^[a-z0-9_.]{3,20}$/i.test(t);
}

export function hasBadHandleSyntax(to: string): boolean {
  const t = to.trim();
  return t.startsWith("@") && !isValidHandleRecipient(t);
}

export function classifyRecipientInput(to: string): RecipientKind {
  const t = to.trim();
  if (looksLikeStellarAddressInput(t)) return isValidStellarAddress(t) ? "address" : "invite";
  if (t.startsWith("@")) return "handle";
  if (isValidHandleRecipient(t)) return "handle";
  return "invite";
}
