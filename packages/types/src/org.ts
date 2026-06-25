import type { MemberId, OrgId, ShieldedAddress, StellarAddress, Timestamp } from "./common.js";

/** KYB lifecycle for the business entity. */
export type KybStatus = "unverified" | "pending" | "approved" | "rejected";

/** A business tenant — the top-level account everything hangs off. */
export interface Org {
  id: OrgId;
  name: string;
  legalName?: string;
  /** ISO-3166 alpha-2 country code */
  country?: string;
  kybStatus: KybStatus;
  /** active compliance zone (ASP allow/deny root set), e.g. "us" | "eu" */
  complianceZoneId?: string;
  /** custodied asset for this org (MVP: USDC) */
  baseAssetCode: string;
  createdAt: Timestamp;
}

/**
 * Roles map to capabilities AND to the on-chain authority a member holds.
 * `auditor` is a scoped viewing-key holder (read-only, never a signer).
 */
export type Role = "owner" | "admin" | "treasurer" | "approver" | "auditor";

export const ROLES: readonly Role[] = ["owner", "admin", "treasurer", "approver", "auditor"];

/** Fine-grained permissions evaluated by the BFF + reflected in the UI. */
export type Permission =
  | "org.manage"
  | "members.manage"
  | "policy.manage"
  | "payment.initiate"
  | "payment.approve"
  | "payment.release"
  | "payroll.run"
  | "invoice.manage"
  | "counterparty.manage"
  | "integration.manage"
  | "viewkey.grant"
  | "ledger.read"
  | "audit.read";

/** Default permission grants per role (the BFF is the source of truth). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    "org.manage",
    "members.manage",
    "policy.manage",
    "payment.initiate",
    "payment.approve",
    "payment.release",
    "payroll.run",
    "invoice.manage",
    "counterparty.manage",
    "integration.manage",
    "viewkey.grant",
    "ledger.read",
    "audit.read",
  ],
  admin: [
    "members.manage",
    "policy.manage",
    "payment.initiate",
    "payment.approve",
    "invoice.manage",
    "counterparty.manage",
    "integration.manage",
    "viewkey.grant",
    "ledger.read",
    "audit.read",
  ],
  treasurer: [
    "payment.initiate",
    "payment.release",
    "payroll.run",
    "invoice.manage",
    "counterparty.manage",
    "ledger.read",
  ],
  approver: ["payment.approve", "ledger.read"],
  auditor: ["ledger.read", "audit.read"],
};

export type MemberStatus = "invited" | "active" | "suspended";

/** A person in an org. Holds a viewing-key public part + an optional signer. */
export interface Member {
  id: MemberId;
  orgId: OrgId;
  email: string;
  name?: string;
  role: Role;
  status: MemberStatus;
  /** member's MVK public scalar (hex) — lets them decode in-scope notes */
  mvkPublic?: string;
  /** signer G-address for multisig authorization (treasurer/approver) */
  signerAddress?: StellarAddress;
  createdAt: Timestamp;
}

/** A shielded payment address material a counterparty/member resolves to. */
export interface PaymentAddress {
  shielded: ShieldedAddress;
  /** BN254 spend public key (hex) */
  spendPub: string;
  /** X25519 note-discovery public key (hex) */
  viewPub: string;
  /** MVK scalar (hex) */
  mvkScalar: string;
}
