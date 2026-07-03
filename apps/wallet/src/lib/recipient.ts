import { type BenzoRecipient } from "@benzo/core";
import { isValidStellarAddress } from "./strkey";

export type RecipientKind = "private" | "address" | "invite";

export function encodeRecipient(rec: BenzoRecipient): string {
  const payload = {
    s: rec.spendPub.toString(16),
    v: Array.from(rec.viewPub, (x) => x.toString(16).padStart(2, "0")).join(""),
    m: rec.mvkScalar ? rec.mvkScalar.toString(16) : undefined,
    l: rec.label,
  };
  return "bzr_" + btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function decodeRecipient(str: string): BenzoRecipient | null {
  try {
    if (!str.startsWith("bzr_")) return null;
    const base64 = str.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    const payload = JSON.parse(json);
    const viewPub = new Uint8Array(payload.v.length / 2);
    for (let i = 0; i < viewPub.length; i++) {
      viewPub[i] = parseInt(payload.v.slice(i * 2, i * 2 + 2), 16);
    }
    return {
      spendPub: BigInt("0x" + payload.s),
      viewPub,
      mvkScalar: payload.m ? BigInt("0x" + payload.m) : undefined,
      label: payload.l,
    };
  } catch {
    return null;
  }
}

export function looksLikeStellarAddressInput(to: string): boolean {
  const t = to.trim();
  return /^G[A-Z2-7]+$/.test(t) && t.length > 20;
}

export function classifyRecipientInput(to: string): RecipientKind {
  const t = to.trim();
  if (looksLikeStellarAddressInput(t)) {
    return isValidStellarAddress(t) ? "address" : "invite";
  }
  if (t.startsWith("bzr_")) {
    return decodeRecipient(t) !== null ? "private" : "invite";
  }
  return "invite";
}
