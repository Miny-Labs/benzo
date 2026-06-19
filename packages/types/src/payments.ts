import type {
  AccountId,
  ApprovalPolicyId,
  CounterpartyId,
  MemberId,
  Money,
  OrgId,
  PaymentOrderId,
  Timestamp,
} from "./common.js";
import type { Approval } from "./approvals.js";

/** Every money movement is ONE canonical resource, typed by intent. */
export type PaymentType =
  | "shielded_transfer"
  | "invoice_payment"
  | "payroll_payout"
  | "onramp"
  | "offramp";

/**
 * The canonical money-movement state machine. A shielded transfer flows
 * created → needs_approval → approved → proving → submitting →
 * submitted_onchain → confirmed; ramps add awaiting_kyc / awaiting_deposit /
 * settled. Terminal states: confirmed, settled, failed, cancelled, expired.
 */
export type PaymentStatus =
  | "created"
  | "needs_approval"
  | "approved"
  | "proving"
  | "submitting"
  | "submitted_onchain"
  | "confirmed"
  | "awaiting_kyc"
  | "awaiting_deposit"
  | "settled"
  | "failed"
  | "cancelled"
  | "expired";

/** Valid transitions — the BFF enforces these; the UI reflects them. */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ["needs_approval", "approved", "cancelled"],
  needs_approval: ["approved", "cancelled", "expired"],
  approved: ["proving", "awaiting_kyc", "cancelled"],
  proving: ["submitting", "failed"],
  submitting: ["submitted_onchain", "failed"],
  submitted_onchain: ["confirmed", "failed"],
  confirmed: [],
  awaiting_kyc: ["awaiting_deposit", "cancelled", "failed"],
  awaiting_deposit: ["proving", "settled", "failed", "expired"],
  settled: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "confirmed",
  "settled",
  "failed",
  "cancelled",
  "expired",
];

/** What a given payment reveals vs hides — surfaced at the confirm step. */
export interface PrivacyDisclosure {
  amountHidden: boolean;
  counterpartyHidden: boolean;
  /** member/auditor ids who currently CAN decode this payment via a viewing key */
  visibleTo: string[];
}

/** On-chain settlement artifacts (populated as the payment progresses). */
export interface SettlementRefs {
  txHash?: string;
  nullifiers?: string[];
  commitments?: string[];
  /** anchor/ramp provider transaction id (off/on-ramp legs) */
  providerTxId?: string;
  /** TRUE only when really settled on-chain. false/undefined => not on-chain. */
  onChain?: boolean;
  /** "onchain" = real testnet settlement; "demo" = BFF not live or no recipient
   *  handle, so NO real settlement happened (and `txHash` is intentionally unset). */
  mode?: "onchain" | "demo";
}

/** The canonical payment order across all rails. */
export interface PaymentOrder {
  id: PaymentOrderId;
  orgId: OrgId;
  type: PaymentType;
  status: PaymentStatus;
  amount: Money;
  /** optional public fee paid to the relayer (gasless), minor units */
  feeAmount?: string;
  fromAccountId: AccountId;
  toCounterpartyId?: CounterpartyId;
  memo?: string;
  /** client-supplied reference / external id */
  ref?: string;
  approvalPolicyId?: ApprovalPolicyId;
  /** recorded maker-checker approvals (who approved which step) */
  approvals?: Approval[];
  privacy: PrivacyDisclosure;
  settlement: SettlementRefs;
  createdByMemberId: MemberId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
