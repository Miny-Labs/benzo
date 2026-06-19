/**
 * The BFF <-> console contract: request/response DTOs + the endpoint registry.
 * The console UI imports these so screens are typed against the API, and the
 * BFF implements them. Composite "view" DTOs (DashboardSummary, TreasuryView)
 * are read-optimized projections the dashboard renders directly.
 */
import type { Account, Counterparty } from "./accounts.js";
import type { Approval, ApprovalPolicy } from "./approvals.js";
import type { ComplianceZone, DisclosureTier, GrantScope, ViewingGrant } from "./compliance.js";
import type { Money, Timestamp } from "./common.js";
import type { Integration, IntegrationProvider } from "./integrations.js";
import type { Invoice, LineItem } from "./invoices.js";
import type { LedgerEntry } from "./ledger.js";
import type { Member, Org, Role } from "./org.js";
import type { PaymentOrder, PaymentType } from "./payments.js";
import type { PayrollBatch, PayrollSource } from "./payroll.js";

// ---- auth / session -------------------------------------------------------

export interface AuthSession {
  member: Member;
  org: Org;
  permissions: string[];
}

// ---- dashboard / treasury (read-optimized projections) --------------------

export interface ActivityItem {
  id: string;
  kind: "payment" | "invoice" | "payroll" | "deposit" | "withdrawal" | "grant";
  title: string;
  status: string;
  /** display amount (may be "Private" when the viewer can't decode) */
  amountLabel: string;
  at: Timestamp;
}

export interface DashboardSummary {
  /** total shielded position the caller can decode, minor units */
  totalPosition: Money;
  /** count of items awaiting THIS member's approval */
  pendingApprovals: number;
  /** open invoices + scheduled payroll counts */
  openInvoices: number;
  scheduledPayrolls: number;
  recentActivity: ActivityItem[];
  /** TRUE when the BFF is serving real on-chain data; false => seeded demo data. */
  live: boolean;
}

/** GET /api/live — is the BFF wired to live testnet, and if not, why. */
export interface LiveStatusResponse {
  live: boolean;
  mode: "live" | "demo";
  /** env vars that are missing/blocking live mode (empty when live). */
  missing: string[];
}

export interface TreasuryAccountView {
  account: Account;
  /** decoded balance (minor units) or null if not in the caller's view */
  balance: Money | null;
}

export interface TreasuryView {
  /** aggregate of all decodable account balances */
  totalHidden: Money;
  accounts: TreasuryAccountView[];
  /** whether a prove-balance proof can be produced for a threshold */
  proveBalanceAvailable: boolean;
  /** TRUE => real decoded on-chain balance; false => seeded demo balances. */
  live: boolean;
}

// ---- request DTOs ---------------------------------------------------------

export interface CreatePaymentRequest {
  type: PaymentType;
  fromAccountId: string;
  toCounterpartyId: string;
  amount: Money;
  memo?: string;
  ref?: string;
  /** route through the gasless relayer */
  useRelayer?: boolean;
}

export interface ApproveRequest {
  decision: "approved" | "denied";
  comment?: string;
}

export interface CreateInvoiceRequest {
  counterpartyId: string;
  number?: string;
  lineItems: LineItem[];
  assetCode: string;
  dueDate?: string;
}

export interface CreatePayrollRequest {
  period: string;
  source: PayrollSource;
  /**
   * The run is assembled from a list of contractors; the BFF COMPUTES each gross
   * from the contractor's stored rate card (`amount` is optional and, when
   * present, is only an override the server still validates — never blindly summed).
   */
  lines: Array<{ counterpartyId: string; amount?: string }>;
  scheduledAt?: string;
}

export interface CreateCounterpartyRequest {
  name: string;
  type: Counterparty["type"];
  email?: string;
  /** when omitted, the BFF mints a self-serve onboarding invite link */
  invite?: boolean;
}

export interface CreateApprovalPolicyRequest {
  name: string;
  policy: Omit<ApprovalPolicy, "id" | "orgId" | "createdAt">;
}

export interface InviteMemberRequest {
  email: string;
  role: Role;
}

export interface CreateViewingGrantRequest {
  auditorName: string;
  auditorPubKey: string;
  tier: DisclosureTier;
  scope: GrantScope;
  /** ISO timestamp */
  expiry: Timestamp;
}

export interface ConnectIntegrationRequest {
  provider: IntegrationProvider;
  /** sandbox OAuth/public token or linked-account token (sandbox only) */
  token?: string;
}

export interface ProveBalanceRequest {
  /** threshold to prove >= , minor units */
  min: string;
}

export interface ProveBalanceResponse {
  /** the org holds at least `min` (proof attached) */
  holds: boolean;
  proof: string;
  /** TRUE => real Groth16 proof from testnet; false => demo stub (BFF not live). */
  onChain: boolean;
}

// ---- endpoint registry (method + path template) ---------------------------

export interface Endpoint {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
}

/** The canonical REST surface. `:id` segments are path params. */
export const ENDPOINTS = {
  session: { method: "GET", path: "/api/session" },
  dashboard: { method: "GET", path: "/api/dashboard" },
  treasury: { method: "GET", path: "/api/treasury" },
  proveBalance: { method: "POST", path: "/api/treasury/prove-balance" },

  members: { method: "GET", path: "/api/members" },
  inviteMember: { method: "POST", path: "/api/members" },

  accounts: { method: "GET", path: "/api/accounts" },

  counterparties: { method: "GET", path: "/api/counterparties" },
  createCounterparty: { method: "POST", path: "/api/counterparties" },

  payments: { method: "GET", path: "/api/payments" },
  createPayment: { method: "POST", path: "/api/payments" },
  payment: { method: "GET", path: "/api/payments/:id" },
  approvePayment: { method: "POST", path: "/api/payments/:id/approve" },

  invoices: { method: "GET", path: "/api/invoices" },
  createInvoice: { method: "POST", path: "/api/invoices" },

  payrolls: { method: "GET", path: "/api/payrolls" },
  createPayroll: { method: "POST", path: "/api/payrolls" },
  approvePayroll: { method: "POST", path: "/api/payrolls/:id/approve" },

  policies: { method: "GET", path: "/api/policies" },
  createPolicy: { method: "POST", path: "/api/policies" },

  grants: { method: "GET", path: "/api/grants" },
  createGrant: { method: "POST", path: "/api/grants" },
  revokeGrant: { method: "POST", path: "/api/grants/:id/revoke" },

  zones: { method: "GET", path: "/api/compliance/zones" },

  ledger: { method: "GET", path: "/api/ledger" },
  auditLog: { method: "GET", path: "/api/audit" },

  integrations: { method: "GET", path: "/api/integrations" },
  connectIntegration: { method: "POST", path: "/api/integrations" },
} as const satisfies Record<string, Endpoint>;

// ---- response aliases (entity returns) ------------------------------------

export type MembersResponse = Member[];
export type AccountsResponse = Account[];
export type CounterpartiesResponse = Counterparty[];
export type PaymentsResponse = PaymentOrder[];
export type InvoicesResponse = Invoice[];
export type PayrollsResponse = PayrollBatch[];
export type PoliciesResponse = ApprovalPolicy[];
export type GrantsResponse = ViewingGrant[];
export type ZonesResponse = ComplianceZone[];
export type LedgerResponse = LedgerEntry[];
export type IntegrationsResponse = Integration[];
export type ApprovalsResponse = Approval[];
