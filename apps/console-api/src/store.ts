/**
 * Console product store. Hosted requests use an encrypted per-org tenant
 * document; local dev keeps the seeded Acme workspace for fast testnet demos.
 * Product state is off-chain by design, but it must still be durable and tenant
 * isolated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Account,
  ApprovalPolicy,
  ComplianceZone,
  Counterparty,
  Integration,
  Invoice,
  LedgerEntry,
  Member,
  Org,
  PaymentOrder,
  PayrollBatch,
  ViewingGrant,
} from "@benzo/types";
import type { PrivateEventEnvelope } from "@benzo/private-events";
import type { AccountBinding } from "./auth.js";
import { hostedRuntime } from "./runtime.js";
import { loadTenantDocument, saveTenantDocument, tenantStorageMissing } from "./tenantData.js";

let seq = 0;
export function id(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Date.now().toString(36)}`;
}
export function now(): string {
  return new Date().toISOString();
}
/** USDC has 7 decimals; helper to write whole-dollar amounts as stroops. */
export function usd(dollars: number): string {
  return Math.round(dollars * 1e7).toString();
}

/** stroops (7dp) -> "$1,234.56" for human-facing activity labels. */
export function fmtUsd(minor: string | bigint): string {
  let n: bigint;
  try {
    n = typeof minor === "bigint" ? minor : BigInt(minor || "0");
  } catch {
    return String(minor);
  }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = (abs / 10_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
  return `${neg ? "-" : ""}$${whole}.${cents}`;
}

/** Parse a human USDC amount ("4200", "4,200.50", "$4200") to stroops, or null. */
function rateToStroops(s: string): bigint | null {
  const clean = (s ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,7})?$/.test(clean)) return null;
  const [w, f = ""] = clean.split(".");
  return BigInt(w) * 10_000_000n + BigInt(f.padEnd(7, "0"));
}

export interface RosterCsvRow {
  name: string;
  handle?: string;
  /** rate in stroops */
  rate: string;
}

/**
 * Parse a contractor roster CSV: `name,handle,rate` (or `name,rate`). `rate` is a
 * human USDC amount; the returned `rate` is stroops. A header row naming the
 * columns is auto-detected and skipped. Returns valid rows + per-line errors
 * (which surface into PayrollLine.error so a bad import row is visible, not silent).
 */
export function parseRosterCsv(text: string): { rows: RosterCsvRow[]; errors: { line: number; error: string }[] } {
  const rows: RosterCsvRow[] = [];
  const errors: { line: number; error: string }[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let start = 0;
  // Auto-skip a header row: if row 0's rate cell isn't a parseable amount, it's labels.
  if (lines[0]) {
    const c0 = lines[0].split(",").map((c) => c.trim());
    const rate0 = c0.length >= 3 ? c0[2] : c0[1];
    if (rateToStroops(rate0 ?? "") === null) start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const name = cols[0];
    const threeCol = cols.length >= 3;
    const handleRaw = threeCol ? cols[1] : "";
    const rateStr = threeCol ? cols[2] : cols[1];
    if (!name) {
      errors.push({ line: i + 1, error: "missing name" });
      continue;
    }
    const stroops = rateToStroops(rateStr ?? "");
    if (stroops === null) {
      errors.push({ line: i + 1, error: `invalid rate for "${name}"` });
      continue;
    }
    const handle = handleRaw ? (handleRaw.startsWith("@") ? handleRaw : `@${handleRaw}`) : undefined;
    rows.push({ name, handle, rate: stroops.toString() });
  }
  return { rows, errors };
}

export interface Db {
  org: Org;
  members: Member[];
  accounts: Account[];
  counterparties: Counterparty[];
  payments: PaymentOrder[];
  invoices: Invoice[];
  payrolls: PayrollBatch[];
  policies: ApprovalPolicy[];
  grants: ViewingGrant[];
  zones: ComplianceZone[];
  ledger: LedgerEntry[];
  integrations: Integration[];
  invites: OrgInvite[];
  onboarding: OnboardingDraft;
  privateEvents: PrivateEventEnvelope[];
  recovery: RecoveryBinding | null;
  proofReceipts: ProofReceipt[];
  idempotency: Record<string, IdempotencyRecord>;
  /** the session member (owner) */
  sessionMemberId: string;
}

export interface RecoveryBinding {
  accountFingerprint: string;
  subjectKey: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface RecoverySummary {
  bound: boolean;
  createdAt?: string;
  lastSeenAt?: string;
  status: "unbound" | "healthy";
  custody: "non-custodial";
  nextSteps: string[];
}

export class RecoveryRequiredError extends Error {
  readonly code = "account_binding_changed";
  constructor(
    readonly storedAccountFingerprint: string,
    readonly currentAccountFingerprint: string,
  ) {
    super("This account needs recovery before it can use this console.");
  }
}

export interface ProofReceipt {
  id: string;
  action: string;
  vkId: string;
  verified: boolean;
  verifier?: string;
  network?: string;
  txHash?: string;
  root?: string;
  publicInputs?: unknown;
  createdAt: string;
}

export interface IdempotencyRecord {
  bodyHash: string;
  status: number;
  body: unknown;
  createdAt: string;
}

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

export interface OrgInvite {
  id: string;
  kind: "member" | "contractor" | "customer";
  name?: string;
  email?: string;
  role?: string;
  counterpartyId?: string;
  link: string;
  token: string;
  expiresAt?: number;
  status: "sent" | "accepted" | "revoked";
  createdAt: string;
}

export function seed(): Db {
  const orgId = "org_acme";
  const org: Org = {
    id: orgId,
    name: "Acme Robotics",
    legalName: "Acme Robotics Inc.",
    country: "US",
    kybStatus: "approved",
    complianceZoneId: "zone_us",
    baseAssetCode: "USDC",
    createdAt: now(),
  };

  const owner: Member = { id: "mem_owner", orgId, email: "founder@acme.test", name: "Jordan Lee", role: "owner", status: "active", createdAt: now() };
  const members: Member[] = [
    owner,
    { id: "mem_treas", orgId, email: "treasury@acme.test", name: "Sam Rivera", role: "treasurer", status: "active", createdAt: now() },
    { id: "mem_appr", orgId, email: "cfo@acme.test", name: "Priya Patel", role: "approver", status: "active", createdAt: now() },
    { id: "mem_aud", orgId, email: "auditor@external.test", name: "External Auditor", role: "auditor", status: "active", createdAt: now() },
  ];

  const accounts: Account[] = [
    { id: "acc_op", orgId, name: "Operating", type: "operating", assetCode: "USDC", createdAt: now() },
    { id: "acc_pay", orgId, name: "Payroll", type: "payroll", assetCode: "USDC", createdAt: now() },
    { id: "acc_tre", orgId, name: "Treasury", type: "treasury", assetCode: "USDC", createdAt: now() },
  ];

  const counterparties: Counterparty[] = [
    // Contractors carry a rate card (payRate) — the source a payroll run COMPUTES from.
    { id: "cp_grace", orgId, name: "Grace Hopper", type: "contractor", status: "allowlisted", email: "grace@contractors.test", paymentAddress: { shielded: "@benzowallet", spendPub: "testnet-spend-cp-grace", viewPub: "testnet-view-cp-grace", mvkScalar: "testnet-mvk-cp-grace" }, externalAccounts: [], taxFormType: "W8-BEN", payRate: { amount: usd(4200), assetCode: "USDC" }, payCadence: "monthly", createdAt: now() },
    { id: "cp_ada", orgId, name: "Ada Lovelace", type: "contractor", status: "allowlisted", email: "ada@contractors.test", paymentAddress: { shielded: "@benzowallet", spendPub: "testnet-spend-cp-ada", viewPub: "testnet-view-cp-ada", mvkScalar: "testnet-mvk-cp-ada" }, externalAccounts: [], taxFormType: "W8-BEN", payRate: { amount: usd(7000), assetCode: "USDC" }, payCadence: "monthly", createdAt: now() },
    { id: "cp_nico", orgId, name: "Nico Vega", type: "contractor", status: "allowlisted", email: "nico@contractors.test", paymentAddress: { shielded: "@benzowallet", spendPub: "testnet-spend-cp-nico", viewPub: "testnet-view-cp-nico", mvkScalar: "testnet-mvk-cp-nico" }, externalAccounts: [], taxFormType: "W8-BEN", payRate: { amount: usd(3500), assetCode: "USDC" }, payCadence: "monthly", createdAt: now() },
    { id: "cp_new", orgId, name: "Lucía Marín", type: "contractor", status: "pending_screening", externalAccounts: [], payRate: { amount: usd(2800), assetCode: "USDC" }, payCadence: "monthly", createdAt: now() },
    { id: "cp_supplier", orgId, name: "Shenzhen Parts Co.", type: "vendor", status: "allowlisted", paymentAddress: { shielded: "@benzowallet", spendPub: "testnet-spend-cp-supplier", viewPub: "testnet-view-cp-supplier", mvkScalar: "testnet-mvk-cp-supplier" }, externalAccounts: [], externalId: "QBO:VEND:11", createdAt: now() },
  ];

  const policies: ApprovalPolicy[] = [
    {
      id: "pol_default",
      orgId,
      name: "Payments over $5k need CFO approval",
      conditions: [{ field: "amount", operator: "gte", value: usd(5000) }],
      steps: [{ role: "approver", mode: "all", minApprovers: 1 }],
      releaseGate: { role: "treasurer", mode: "all", minApprovers: 1 },
      reApprovalTriggers: ["amount", "counterparty", "bank_details"],
      createdAt: now(),
    },
  ];

  const payments: PaymentOrder[] = [
    {
      id: "po_2", orgId, type: "shielded_transfer", status: "needs_approval",
      amount: { amount: usd(8200), assetCode: "USDC" }, fromAccountId: "acc_op", toCounterpartyId: "cp_supplier",
      memo: "PO-4480 bulk order", approvalPolicyId: "pol_default", approvals: [],
      privacy: { amountHidden: true, counterpartyHidden: true, visibleTo: ["mem_owner", "mem_treas", "mem_appr"] },
      // proposed by the owner so the approver (Priya) + release-gate treasurer (Sam) can each act (proposer ≠ approver)
      settlement: {}, createdByMemberId: "mem_owner", createdAt: now(), updatedAt: now(),
    },
  ];

  // Inbound (AP) invoices contractors submitted for payment — the invoice-to-pay front-door.
  const invoices: Invoice[] = [
    {
      id: "inv_1", orgId, number: "INV-1001", counterpartyId: "cp_grace",
      lineItems: [{ description: "Design — June", quantity: 1, unitAmount: usd(4200) }],
      total: { amount: usd(4200), assetCode: "USDC" }, status: "open", dueDate: "2026-07-15",
      hostedUrl: "https://pay.benzo.test/i/secret-7f3a", paymentOrderIds: [], createdAt: now(),
    },
    {
      id: "inv_2", orgId, number: "INV-1002", counterpartyId: "cp_nico",
      lineItems: [{ description: "Engineering — June (overage)", quantity: 1, unitAmount: usd(1500) }],
      total: { amount: usd(1500), assetCode: "USDC" }, status: "open", dueDate: "2026-07-20",
      hostedUrl: "https://pay.benzo.test/i/secret-9c2b", paymentOrderIds: [], createdAt: now(),
    },
  ];

  const payrolls: PayrollBatch[] = [
    {
      id: "pr_1", orgId, period: "2026-06", source: "merge", status: "needs_approval",
      lines: [
        { counterpartyId: "cp_ada", amount: usd(7000), status: "pending" },
        { counterpartyId: "cp_grace", amount: usd(4200), status: "pending" },
      ],
      total: { amount: usd(11200), assetCode: "USDC" }, createdAt: now(),
    },
  ];

  const grants: ViewingGrant[] = [
    {
      id: "vg_1", orgId, auditorName: "External Auditor", auditorPubKey: "0xaud1", tier: "outgoing",
      scope: { accountIds: ["acc_pay"], from: "2026-04-01", to: "2026-06-30", label: "Q2 payroll" },
      onChainKeyHash: "kh_9a2f", expiry: "2026-09-30T00:00:00Z", status: "active",
      portalUrl: "https://audit.benzo.test/g/secret-q2", createdAt: now(),
    },
  ];

  const zones: ComplianceZone[] = [
    { id: "zone_us", orgId, name: "United States", jurisdiction: "US", allowRoot: "0xallowUS", denyRoot: "0xdenyUS" },
    { id: "zone_eu", orgId, name: "European Union", jurisdiction: "EU", allowRoot: "0xallowEU", denyRoot: "0xdenyEU" },
  ];

  const ledger: LedgerEntry[] = [];

  const integrations: Integration[] = [
    { id: "int_merge", orgId, provider: "merge", status: "disconnected" },
    { id: "int_qbo", orgId, provider: "quickbooks", status: "disconnected" },
    { id: "int_slack", orgId, provider: "slack", status: "disconnected" },
  ];

  return {
    org, members, accounts, counterparties, payments, invoices, payrolls,
    policies, grants, zones, ledger, integrations,
    invites: [],
    onboarding: {},
    privateEvents: [],
    recovery: null,
    proofReceipts: [],
    idempotency: {},
    sessionMemberId: owner.id,
  };
}

export function freshHostedDb(authKey: string, claims?: { email?: string; name?: string }): Db {
  const orgId = `org_${authKey.slice(0, 12)}`;
  const createdAt = now();
  const owner: Member = {
    id: "mem_owner",
    orgId,
    email: claims?.email ?? "owner@benzo.local",
    name: claims?.name ?? claims?.email?.split("@")[0] ?? "Owner",
    role: "owner",
    status: "active",
    createdAt,
  };
  const policies: ApprovalPolicy[] = [
    {
      id: "pol_default",
      orgId,
      name: "Payments over $5k need approval",
      conditions: [{ field: "amount", operator: "gte", value: usd(5000) }],
      steps: [{ role: "owner", mode: "all", minApprovers: 1 }],
      releaseGate: { role: "owner", mode: "all", minApprovers: 1 },
      reApprovalTriggers: ["amount", "counterparty", "bank_details"],
      createdAt,
    },
  ];
  return {
    org: {
      id: orgId,
      name: "New workspace",
      legalName: "New workspace",
      country: "US",
      kybStatus: "unverified",
      complianceZoneId: "zone_us",
      baseAssetCode: "USDC",
      createdAt,
    },
    members: [owner],
    accounts: [
      { id: "acc_op", orgId, name: "Operating", type: "operating", assetCode: "USDC", createdAt },
      { id: "acc_pay", orgId, name: "Payroll", type: "payroll", assetCode: "USDC", createdAt },
      { id: "acc_tre", orgId, name: "Treasury", type: "treasury", assetCode: "USDC", createdAt },
    ],
    counterparties: [],
    payments: [],
    invoices: [],
    payrolls: [],
    policies,
    grants: [],
    zones: [
      { id: "zone_us", orgId, name: "United States", jurisdiction: "US", allowRoot: "0xallowUS", denyRoot: "0xdenyUS" },
      { id: "zone_eu", orgId, name: "European Union", jurisdiction: "EU", allowRoot: "0xallowEU", denyRoot: "0xdenyEU" },
    ],
    ledger: [],
    integrations: [
      { id: "int_merge", orgId, provider: "merge", status: "disconnected" },
      { id: "int_qbo", orgId, provider: "quickbooks", status: "disconnected" },
      { id: "int_slack", orgId, provider: "slack", status: "disconnected" },
    ],
    invites: [],
    onboarding: {},
    privateEvents: [],
    recovery: null,
    proofReceipts: [],
    idempotency: {},
    sessionMemberId: owner.id,
  };
}

const localDb: Db = seed();
const tenantScope = new AsyncLocalStorage<{ key: string; db: Db }>();

function activeDb(): Db {
  return tenantScope.getStore()?.db ?? localDb;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop: keyof Db) {
    return activeDb()[prop];
  },
  set(_target, prop: keyof Db, value) {
    activeDb()[prop] = value as never;
    return true;
  },
  has(_target, prop) {
    return prop in activeDb();
  },
  ownKeys() {
    return Reflect.ownKeys(activeDb());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(activeDb(), prop);
  },
});

export function tenantDataMissing(): string[] {
  return tenantStorageMissing();
}

export function currentConsoleTenantKey(): string | null {
  return tenantScope.getStore()?.key ?? null;
}

function hostedTenantMode(): boolean {
  return hostedRuntime() || process.env.BENZO_HOSTED_TENANT_TEST === "1";
}

function normalizeConsoleDb(value: Db): Db {
  value.invites ??= [];
  value.onboarding ??= {};
  value.privateEvents ??= [];
  value.recovery ??= null;
  value.proofReceipts ??= [];
  value.idempotency ??= {};
  return value;
}

function bindRecovery(value: Db, binding: AccountBinding | null): void {
  if (!binding) return;
  const seenAt = now();
  if (!value.recovery) {
    value.recovery = {
      accountFingerprint: binding.accountFingerprint,
      subjectKey: binding.subjectKey,
      createdAt: seenAt,
      lastSeenAt: seenAt,
    };
    return;
  }
  if (value.recovery.accountFingerprint !== binding.accountFingerprint) {
    throw new RecoveryRequiredError(value.recovery.accountFingerprint, binding.accountFingerprint);
  }
  value.recovery.subjectKey = binding.subjectKey;
  value.recovery.lastSeenAt = seenAt;
}

export function recoverySummary(): RecoverySummary {
  const recovery = db.recovery;
  if (!recovery) {
    return {
      bound: false,
      status: "unbound",
      custody: "non-custodial",
      nextSteps: [
        "Finish sign-in as an owner to bind this workspace key.",
        "Add at least one backup owner before moving real funds.",
      ],
    };
  }
  return {
    bound: true,
    status: "healthy",
    custody: "non-custodial",
    createdAt: recovery.createdAt,
    lastSeenAt: recovery.lastSeenAt,
    nextSteps: [
      "Use this Google sign-in to keep access to the workspace key.",
      "If the key changes, another owner must approve a reviewed workspace migration.",
    ],
  };
}

export async function runWithConsoleTenant<T>(
  authKey: string | null,
  claims: { email?: string; name?: string } | null,
  binding: AccountBinding | null,
  fn: () => Promise<T>,
  options: { persist?: boolean } = {},
): Promise<T> {
  if (!hostedTenantMode() || !authKey) return fn();
  const persist = options.persist ?? true;
  const tenantKey = `console:${authKey}`;
  const loaded = await loadTenantDocument<Db>("console", tenantKey);
  const ctx = { key: tenantKey, db: normalizeConsoleDb(loaded ?? freshHostedDb(authKey, claims ?? undefined)) };
  if (persist) bindRecovery(ctx.db, binding);
  return tenantScope.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      if (persist) await saveTenantDocument("console", tenantKey, ctx.db);
    }
  });
}

export async function runWithConsoleTenantKey<T>(
  tenantKey: string | null,
  fn: () => Promise<T>,
  options: { persist?: boolean } = {},
): Promise<T> {
  if (!hostedTenantMode() || !tenantKey) return fn();
  const persist = options.persist ?? true;
  const loaded = await loadTenantDocument<Db>("console", tenantKey);
  if (!loaded) throw new Error("tenant not found");
  const ctx = { key: tenantKey, db: normalizeConsoleDb(loaded) };
  return tenantScope.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      if (persist) await saveTenantDocument("console", tenantKey, ctx.db);
    }
  });
}
