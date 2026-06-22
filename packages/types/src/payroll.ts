import type {
  CounterpartyId,
  Money,
  OrgId,
  PayrollBatchId,
  Timestamp,
} from "./common.js";
import type { Approval } from "./approvals.js";

/** Per-recipient line status within a batch. */
export type PayrollLineStatus = "pending" | "paid" | "failed";

/** Where the payroll roster came from (sandbox sources are first-class). */
export type PayrollSource = "manual" | "csv" | "merge" | "gusto";

/** Batch lifecycle — one approval, one batched shielded settlement. */
export type PayrollStatus =
  | "draft"
  | "needs_approval"
  | "approved"
  | "processing"
  | "completed"
  | "cancelled";

export interface PayrollLine {
  counterpartyId: CounterpartyId;
  /** per-recipient gross, minor units (string) — COMPUTED server-side from the
   *  contractor's stored rate at run assembly, hidden on-chain at settlement. */
  amount: string;
  /** the rate card the gross was computed from (for the payslip/record audit trail) */
  rate?: string;
  status: PayrollLineStatus;
  /** settlement tx hash once paid */
  txHash?: string;
  /** TRUE only when really settled on-chain; false/undefined => demo (not settled). */
  onChain?: boolean;
  /** populated for CSV/import rows that failed validation */
  error?: string;
  /** in-ZK spending policy (Z3): proof this payout is within the approved cap
   *  (vk_id SPENDCAP), verified on-chain, WITHOUT revealing the amount.
   *  `withinCap:false` => over the cap, provably blocked. */
  capProof?: { withinCap: boolean; onChain: boolean };
  /** per-payout proof-of-innocence (Z4): proof the recipient is NOT on the
   *  sanctions/deny set (vk_id POIPAYOUT), verified on-chain, recipient hidden.
   *  `innocent:false` => sanctioned recipient, provably blocked. */
  screenProof?: { innocent: boolean; onChain: boolean };
}

/** A confidential batch payout (each per-recipient amount is note-hidden). */
export interface PayrollBatch {
  id: PayrollBatchId;
  orgId: OrgId;
  /** human label, e.g. "2026-06 payroll" */
  period: string;
  source: PayrollSource;
  status: PayrollStatus;
  lines: PayrollLine[];
  /** aggregate total, minor units */
  total: Money;
  /** ISO timestamp the run is scheduled for */
  scheduledAt?: string;
  /** join key for accounting/HRIS sync */
  externalId?: string;
  /** recorded maker-checker approvals (who approved which step) */
  approvals?: Approval[];
  /** "Payroll funded ✓" — a real Groth16 org-proof-of-balance (vk_id ORGBAL),
   *  proving the treasury covers this run's TOTAL without revealing the treasury
   *  or the total. `funded:false` => an over-budget run, provably blocked. */
  fundedProof?: { funded: boolean; onChain: boolean; provenAt: Timestamp };
  /** Anonymous approver / surveillance-free dual-control (vk_id ORGAUTH):
   *  proof that >= threshold DISTINCT approvers signed this run, verified
   *  on-chain, WITHOUT revealing which. */
  approvalProof?: { approved: boolean; onChain: boolean; approvers: number; threshold: number; memberCount: number; provenAt: Timestamp };
  /** Verifiable payroll computation (vk_id PAYCOMP): proof the run total + per-
   *  line commitments were derived from the rate card (rate×period−deductions),
   *  verified on-chain, with the rate card kept private. */
  computationProof?: { ok: boolean; onChain: boolean; runTotal: string; provenAt: Timestamp };
  createdAt: Timestamp;
}
