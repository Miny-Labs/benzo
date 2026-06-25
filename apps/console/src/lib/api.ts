/**
 * Typed client for @benzo/console-api (Vite proxies "/api" → :8790). Screens use
 * ONLY this — typed against @benzo/types, so the UI and BFF share one contract.
 */
import type {
  Account,
  ApprovalPolicy,
  ApproveRequest,
  AuthSession,
  Counterparty,
  CreatePaymentRequest,
  CreatePayrollRequest,
  CreateViewingGrantRequest,
  DashboardSummary,
  Integration,
  Invoice,
  LedgerEntry,
  LiveStatusResponse,
  Member,
  PaymentOrder,
  PayrollBatch,
  TreasuryView,
  ViewingGrant,
} from "@benzo/types";

import type { OnChainRef } from "../ui/onchain";
import { localConsole, localPayrollLines, type ConsoleSeed, type OrgInvite, type PayrollProofResponses } from "./localConsoleState";
export type { OnChainRef };
export type { OrgInvite };

/** Maker-checker progress the BFF returns alongside an approve action. */
export interface ApprovalProgressView {
  required: boolean;
  satisfied: boolean;
  nextRole: string | null;
  nextKind: "approve" | "release" | null;
  steps: Array<{ stepIndex: number; role: string; need: number; have: number; satisfied: boolean; kind: "approve" | "release" }>;
}

export interface PrivateEventEnvelopeView {
  id: string;
  orgId: string;
  type: string;
  subjectId: string;
  schema: string;
  occurredAt: string;
  publicMeta: Record<string, string | number | boolean | null>;
  ciphertext: string;
  iv: string;
  tag: string;
  aadHash: string;
  payloadHash: string;
  prevHash: string;
  hash: string;
}

export interface PrivateAuditPacketResponse {
  packet: {
    orgId: string;
    scope: { label: string; from?: string; to?: string; eventTypes?: string[]; subjectIds?: string[] };
    anchor: { orgId: string; eventCount: number; headHash: string; merkleRoot: string; anchoredAt: string; txHash?: string };
    envelopes: PrivateEventEnvelopeView[];
    inclusionProofs: Array<{ eventHash: string; siblings: string[]; index: number }>;
    issuedAt: string;
  };
  integrity: { ok: boolean; headHash: string; brokenAt?: number };
  disclosure: string;
}

export interface PrivateAuditAnchorResponse extends PrivateAuditPacketResponse {
  packetHash: string;
  orgHash: string;
  anchor: {
    onChain: boolean;
    contractId?: string;
    txHash?: string;
    sequence?: string;
    error?: string;
    explorer?: string;
  };
}

export function apiHref(path: string): string {
  return `/api/rpc?path=${encodeURIComponent(path)}`;
}

const GOOGLE_TOKEN_KEY = "benzo.console.googleCredential";
const GOOGLE_IDENTITY_KEY = "benzo.console.identityKey";

function b64urlJson(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(seg.length / 4) * 4, "="))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function identityKeyFromCredential(credential: string): string {
  const parts = credential.split(".");
  const payload = parts.length === 3 ? b64urlJson(parts[1]) : null;
  const iss = typeof payload?.iss === "string" ? payload.iss : "unknown";
  const aud = typeof payload?.aud === "string" ? payload.aud : "unknown";
  const sub = typeof payload?.sub === "string" ? payload.sub : "unknown";
  let h = 0x811c9dc5;
  for (const ch of `console|${iss}|${aud}|${sub}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return `g${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function storeGoogleCredential(credential: string): void {
  const nextIdentity = identityKeyFromCredential(credential);
  const prevIdentity = localStorage.getItem(GOOGLE_IDENTITY_KEY);
  if (prevIdentity && prevIdentity !== nextIdentity) localStorage.removeItem("benzo.console.onboarded");
  localStorage.setItem(GOOGLE_IDENTITY_KEY, nextIdentity);
  localStorage.setItem(GOOGLE_TOKEN_KEY, credential);
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiHref(path), {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

async function seedConsole(): Promise<ConsoleSeed> {
  const [session, accounts, members, counterparties, payments, payrolls, invoices, grants, policies, invites] = await Promise.all([
    http<AuthSession>("/session"),
    http<Account[]>("/accounts"),
    http<Member[]>("/members"),
    http<Counterparty[]>("/counterparties"),
    http<PaymentOrder[]>("/payments"),
    http<PayrollBatch[]>("/payrolls"),
    http<Invoice[]>("/invoices"),
    http<ViewingGrant[]>("/grants"),
    http<ApprovalPolicy[]>("/policies"),
    http<OrgInvite[]>("/invites").catch(() => []),
  ]);
  return { session, accounts, members, counterparties, payments, payrolls, invoices, grants, policies, invites };
}

const settlePayment = (body: { amount: { amount: string; assetCode: string }; toHandle?: string; memo?: string }) =>
  http<{ txHash?: string; onChain: boolean; error?: string }>("/settlements/payment", { method: "POST", body: JSON.stringify(body) });

const settlePayroll = (body: { lines: Array<{ counterpartyId: string; amount: string; handle?: string }> }) =>
  http<{ lines: Array<{ counterpartyId: string; status: "pending" | "paid" | "failed"; txHash?: string; onChain?: boolean; error?: string }> }>(
    "/settlements/payroll",
    { method: "POST", body: JSON.stringify(body) },
  );

export interface OnboardingDraft {
  name?: string;
  legalName?: string;
  country?: string;
  entityType?: string;
  registrationNumber?: string;
  taxId?: string;
  beneficialOwners?: Array<{ name: string; ownership?: string }>;
  complianceZoneId?: string;
  team?: Array<{ email: string; role: string }>;
  kyb?: { status: "approved" | "pending" | "rejected" | "unverified"; provider: string; inquiryRef: string; checks: string[]; onChain: boolean; txHash?: string };
  mvk?: { onChain: boolean; txHash?: string; mvkRoot?: string };
}

export const api = {
  session: () => localConsole.session(seedConsole),
  // zkLogin / SSO: is real Google configured, and verify a Google ID token.
  authConfig: () => http<{ googleClientId: string | null; google: boolean }>("/auth/config"),
  googleVerify: (credential: string, nonce?: string) =>
    http<{ verified: boolean; sub?: string; email?: string; name?: string; error?: string; configured?: boolean; encPub?: string }>(
      "/auth/google",
      { method: "POST", body: JSON.stringify({ credential, nonce }) },
    ),
  onboarding: () => http<OnboardingDraft>("/onboarding"),
  saveOnboarding: (patch: OnboardingDraft) =>
    http<OnboardingDraft>("/onboarding", { method: "PATCH", body: JSON.stringify(patch) }),
  submitKyb: (patch: OnboardingDraft) =>
    http<NonNullable<OnboardingDraft["kyb"]>>("/onboarding/kyb", { method: "POST", body: JSON.stringify(patch) }),
  kybStatus: () =>
    http<{ status: "unverified" | "pending" | "approved" | "rejected"; inquiryRef: string; onChain: boolean }>("/onboarding/kyb-status"),
  registerOwnerMvk: () =>
    http<{ onChain: boolean; txHash?: string; mvkRoot?: string }>("/onboarding/register-mvk", { method: "POST", body: "{}" }),
  finishOnboarding: () => http<AuthSession>("/onboarding/finish", { method: "POST", body: "{}" }),
  live: () => http<LiveStatusResponse>("/live"),
  dashboard: async () => localConsole.dashboard(seedConsole, await api.treasury().catch(() => undefined)),
  treasury: () => http<TreasuryView>("/treasury"),
  // Prove reserves: treasury >= a chosen floor on-chain (ORGBAL); returns an on-chain ref.
  proveBalance: (min: string) =>
    http<{ holds: boolean; onChain: boolean; minStroops: string; ref?: OnChainRef }>("/treasury/prove-balance", { method: "POST", body: JSON.stringify({ min }) }),
  proveTotal: () =>
    http<{ total: string; onChain: boolean; ref?: OnChainRef }>("/treasury/prove-total", { method: "POST", body: "{}" }),
  // True solvency: prove treasury >= Σ(pending payroll + open invoices), both hidden.
  proveSolvency: () =>
    http<{ solvent: boolean; onChain: boolean; liabilities: string; ref?: OnChainRef }>("/treasury/prove-solvency", { method: "POST", body: "{}" }),
  // KYB-as-ZK credential (Z7): prove verified business + jurisdiction + tier on-chain (KYB), docs hidden.
  proveKyb: () =>
    http<{ ok: boolean; onChain: boolean; jurisdiction: string; tier: string; ref?: OnChainRef }>("/compliance/kyb-credential", { method: "POST", body: "{}" }),
  // Records export (Z2): network-verified period-total attestation (ORGSUM proof embedded).
  periodTotalAttestation: (period: string) =>
    http<{
      live: boolean; org?: string; period?: string; total?: string; onChain?: boolean;
      vkId?: string; verifier?: string; network?: string; root?: string;
      sorobanProof?: unknown; sorobanPublics?: string[]; issuedAt?: string;
    }>("/records/period-total", { method: "POST", body: JSON.stringify({ period }) }),
  // "Make private" (shield public -> pool). amount in USDC (human).
  fundTreasury: (amount: string) =>
    http<{ onChain: boolean; txHash?: string; error?: string }>("/treasury/fund", { method: "POST", body: JSON.stringify({ amount }) }),
  // Two-balance model. Public = liquid, unshielded USDC (what external wallets see).
  // The org's M-of-N shielded pool is api.treasury(). stroops are 7dp.
  treasuryPublicBalance: () =>
    http<{ stroops: string; address: string; asset: string; issuer: string; live: boolean }>("/treasury/public-balance"),
  // Receive: address + asset/issuer for a Receive QR (inbound lands in Public).
  treasuryReceive: () =>
    http<{ address: string; asset: string; issuer: string; live: boolean }>("/treasury/receive"),
  // "Send to a wallet": real on-chain USDC transfer from Public to an external
  // G-address. amount in USDC (human). Friendly trustline/balance errors in `error`.
  treasurySendPublic: (to: string, amount: string) =>
    http<{ txHash?: string; onChain: boolean; error?: string }>("/treasury/send-public", { method: "POST", body: JSON.stringify({ to, amount }) }),

  accounts: () => localConsole.accounts(seedConsole),
  members: () => localConsole.members(seedConsole),
  counterparties: () => localConsole.counterparties(seedConsole),
  updateCounterparty: (id: string, patch: { payRate?: string; status?: Counterparty["status"]; handle?: string; name?: string }) =>
    localConsole.updateCounterparty(seedConsole, id, patch),
  importRoster: (csv: string) =>
    localConsole.importRoster(seedConsole, csv),
  // Employer-visible pay history for one contractor across every run.
  contractorHistory: (id: string) =>
    localConsole.contractorHistory(seedConsole, id),

  payments: () => localConsole.payments(seedConsole),
  createPayment: (body: CreatePaymentRequest & { toHandle?: string }) =>
    localConsole.createPayment(seedConsole, body, settlePayment),
  approvePayment: (id: string, body: ApproveRequest & { actorMemberId?: string }) =>
    localConsole.approvePayment(seedConsole, id, body, settlePayment),

  payrolls: () => localConsole.payrolls(seedConsole),
  // Amounts are COMPUTED server-side from each contractor's rate card; the caller
  // only chooses WHO is in the run.
  createPayroll: (body: { period: string; source: CreatePayrollRequest["source"]; lines: Array<{ counterpartyId: string }> }) =>
    localConsole.createPayroll(seedConsole, body),
  approvePayroll: (id: string, body: { decision?: "approved" | "denied"; actorMemberId?: string } = { decision: "approved" }) =>
    localConsole.approvePayroll(seedConsole, id, body, settlePayroll),
  // "Payroll funded ✓" — prove ON-CHAIN (ORGBAL) the treasury covers this run's total.
  proveFunded: async (id: string) => {
    const { batch } = await localPayrollLines(seedConsole, id);
    const runTotal = batch.lines.filter((l) => !l.onChain && BigInt(l.amount || "0") > 0n).reduce((s, l) => s + BigInt(l.amount), 0n).toString();
    const r = await http<PayrollProofResponses["funded"]>("/payroll-proofs/funded", { method: "POST", body: JSON.stringify({ runTotal }) });
    await localConsole.markPayrollProof(seedConsole, id, { fundedProof: { funded: r.funded, onChain: r.onChain, provenAt: r.provenAt } });
    return r;
  },
  // Anonymous approver (Z5): prove >= threshold distinct approvers signed, on-chain (ORGAUTH), who hidden.
  proveApproval: async (id: string) => {
    const r = await http<PayrollProofResponses["approval"]>("/payroll-proofs/approval", { method: "POST", body: JSON.stringify({ batchId: id }) });
    await localConsole.markPayrollProof(seedConsole, id, { approvalProof: { approved: r.approved, onChain: r.onChain, approvers: r.approvers, threshold: r.threshold, memberCount: r.memberCount, provenAt: r.provenAt } });
    return r;
  },
  // Verifiable payroll computation (Z6): prove run total derived from the rate card, on-chain (PAYCOMP), rate card private.
  proveComputation: async (id: string) => {
    const { lines } = await localPayrollLines(seedConsole, id);
    const r = await http<PayrollProofResponses["computation"]>("/payroll-proofs/computation", { method: "POST", body: JSON.stringify({ lines }) });
    await localConsole.markPayrollProof(seedConsole, id, { computationProof: { ok: r.ok, onChain: r.onChain, runTotal: r.runTotal, provenAt: r.provenAt } });
    return r;
  },
  // Compliance pre-flight (Z3 cap + Z4 sanctions screen) per line, on-chain, amounts/recipients hidden.
  provePolicy: async (id: string, cap: string) => {
    const { lines } = await localPayrollLines(seedConsole, id);
    const r = await http<PayrollProofResponses["policy"]>("/payroll-proofs/policy", { method: "POST", body: JSON.stringify({ cap, lines }) });
    const { batch } = await localPayrollLines(seedConsole, id);
    await localConsole.markPayrollProof(seedConsole, id, {
      lines: batch.lines.map((line) => {
        const proof = r.lines.find((x) => x.counterpartyId === line.counterpartyId);
        return proof ? { ...line, capProof: proof.capProof, screenProof: proof.screenProof } : line;
      }),
    });
    return r;
  },

  invoices: () => localConsole.invoices(seedConsole),
  payInvoice: (id: string) =>
    localConsole.payInvoice(seedConsole, id, settlePayment),
  // Cross-entity private netting (Z8): net mutual invoices, settle the difference, grosses hidden (NETTING).
  netInvoices: (weOwe: string, theyOwe: string) =>
    http<{ onChain: boolean; net: string; wetPay: boolean; ref?: OnChainRef }>("/invoices/net", { method: "POST", body: JSON.stringify({ weOwe, theyOwe }) }),

  grants: () => localConsole.grants(seedConsole),
  createGrant: (body: CreateViewingGrantRequest) =>
    localConsole.createGrant(seedConsole, body),
  revokeGrant: (id: string) => localConsole.revokeGrant(seedConsole, id),

  policies: () => localConsole.policies(seedConsole),
  updatePolicy: (id: string, patch: Partial<Pick<ApprovalPolicy, "name" | "conditions" | "steps" | "releaseGate">>) =>
    localConsole.updatePolicy(seedConsole, id, patch),

  integrations: () => http<Integration[]>("/integrations"),

  // Tamper-evident double-entry audit trail (each entry hash-chains to the prior).
  ledger: () => http<LedgerEntry[]>("/ledger"),
  // Re-walk the chain server-side and report integrity (ok / brokenAt index).
  ledgerVerify: () => http<{ ok: boolean; length: number; brokenAt?: number }>("/ledger/verify"),
  privateAuditPacket: () => http<PrivateAuditPacketResponse>("/audit/private-events"),
  anchorPrivateAuditRoot: (body?: {
    packet?: PrivateAuditPacketResponse["packet"];
    packetHash?: string;
    orgHash?: string;
  }) =>
    http<PrivateAuditAnchorResponse>("/audit/private-events/anchor", { method: "POST", body: JSON.stringify(body ?? {}) }),
  // Per-contractor payslips for one run (gross, status, on-chain receipt).
  payslips: (id: string) =>
    http<Array<{ period: string; contractor: string; gross: string; status: string; txHash?: string; error?: string }>>(`/payrolls/${id}/payslips`),

  invites: () => localConsole.invites(seedConsole),
  createInvite: (body: { kind: OrgInvite["kind"]; name?: string; email?: string; role?: string; handle?: string }) =>
    localConsole.createInvite(seedConsole, body),
  bulkInvite: (csv: string) =>
    localConsole.bulkInvite(seedConsole, csv),
  revokeInvite: (id: string) => localConsole.revokeInvite(seedConsole, id),
};
