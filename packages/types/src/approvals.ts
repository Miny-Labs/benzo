import type {
  ApprovalPolicyId,
  MemberId,
  OrgId,
  PaymentOrderId,
  PayrollBatchId,
  Timestamp,
} from "./common.js";
import type { Role } from "./org.js";

/**
 * A routing condition. NOTE (privacy crux): conditions reference amount /
 * counterparty, which Benzo hides on-chain — the BFF evaluates the policy over
 * the PLAINTEXT PROPOSAL before a proof is generated.
 */
export interface ApprovalCondition {
  /** the proposal field this condition tests */
  field: "amount" | "counterparty" | "payment_type" | "account";
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "in";
  /** comparison value (minor units string for amount, id/string otherwise) */
  value: string | string[];
}

/** Require ALL approvers in the step (AND) or ANY (OR). */
export type ApprovalMode = "all" | "any";

export interface ApprovalStep {
  /** the role that may approve at this step */
  role: Role;
  mode: ApprovalMode;
  /** minimum number of approvals to clear this step */
  minApprovers: number;
}

/**
 * An ordered approval chain. Stage-1 steps gate the proposal; the optional
 * `releaseGate` is the separate "Payer" gate (release ≠ approve) that maps onto
 * collecting the M-of-N multisig signatures to actually settle.
 */
export interface ApprovalPolicy {
  id: ApprovalPolicyId;
  orgId: OrgId;
  name: string;
  /** policy applies when ALL conditions match (empty = applies to everything) */
  conditions: ApprovalCondition[];
  steps: ApprovalStep[];
  /** the separate release/sign step (multisig collection) */
  releaseGate?: ApprovalStep;
  /** changes to these fields force re-approval (non-disableable) */
  reApprovalTriggers: readonly ("amount" | "counterparty" | "bank_details" | "date")[];
  createdAt: Timestamp;
}

export type ApprovalDecision = "approved" | "denied";

/** A single approval/denial recorded against a payment or payroll batch. */
export interface Approval {
  id: string;
  orgId: OrgId;
  /** exactly one of these is set */
  paymentOrderId?: PaymentOrderId;
  payrollBatchId?: PayrollBatchId;
  stepIndex: number;
  approverMemberId: MemberId;
  decision: ApprovalDecision;
  comment?: string;
  at: Timestamp;
}
