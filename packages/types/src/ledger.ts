import type { AccountId, OrgId, Timestamp } from "./common.js";

/** Double-entry direction. */
export type EntryDirection = "debit" | "credit";

/** What produced a ledger entry (mirrors the on-chain op verbs). */
export type LedgerSourceType =
  | "shield"
  | "transfer"
  | "unshield"
  | "payroll"
  | "invoice"
  | "onramp"
  | "offramp"
  | "fee"
  | "reversal";

/** One leg of a balanced entry. */
export interface LedgerLine {
  accountId: AccountId;
  direction: EntryDirection;
  /** minor units (string) */
  amount: string;
  assetCode: string;
}

/**
 * An immutable, append-only double-entry record. Balances are DERIVED from
 * these (never stored mutably); corrections are reversal entries. This is the
 * CFO/auditor-readable projection of an on-chain shielded movement.
 */
export interface LedgerEntry {
  id: string;
  orgId: OrgId;
  /** on-chain settlement tx hash this entry projects, if any */
  txId?: string;
  postedAt: Timestamp;
  sourceType: LedgerSourceType;
  /** id of the payment/invoice/payroll that produced this entry */
  sourceId?: string;
  lines: LedgerLine[];
  /** if this is a reversal, the entry it reverses */
  reversalOf?: string;
  /** tamper-evident audit chain: SHA-256(prevHash + canonical(this entry)). Each
   *  entry commits to the one before it, so any after-the-fact edit/insert/delete
   *  breaks the chain from that point on (a CFO/auditor can verify the whole log). */
  hash?: string;
}
