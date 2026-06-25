import type {
  Account,
  Approval,
  ApprovalPolicy,
  AuthSession,
  Counterparty,
  DashboardSummary,
  Invoice,
  Member,
  Money,
  PaymentOrder,
  PayrollBatch,
  PayrollLine,
  TreasuryView,
  ViewingGrant,
} from "@benzo/types";
import { encodeBenzoLink } from "@benzo/links";
import type { ApprovalProgressView, OnChainRef } from "./api";

export interface OrgInvite {
  id: string;
  kind: "member" | "contractor" | "customer";
  name?: string;
  email?: string;
  role?: string;
  counterpartyId?: string;
  link: string;
  token: string;
  status: "sent" | "accepted" | "revoked";
  createdAt: string;
}

interface ConsoleSnapshot {
  version: 1;
  savedAt: string;
  session: AuthSession;
  accounts: Account[];
  members: Member[];
  counterparties: Counterparty[];
  payments: PaymentOrder[];
  payrolls: PayrollBatch[];
  invoices: Invoice[];
  grants: ViewingGrant[];
  policies: ApprovalPolicy[];
  invites: OrgInvite[];
}

export type ConsoleSeed = Omit<ConsoleSnapshot, "version" | "savedAt" | "invites"> & { invites?: OrgInvite[] };

type SettlementPayment = (body: { amount: Money; toHandle?: string; memo?: string }) => Promise<{ txHash?: string; onChain: boolean; error?: string }>;
type SettlementPayroll = (body: { lines: Array<{ counterpartyId: string; amount: string; handle?: string }> }) => Promise<{
  lines: Array<{ counterpartyId: string; status: PayrollLine["status"]; txHash?: string; onChain?: boolean; error?: string }>;
}>;

const DB_NAME = "benzo-console-private-state";
const DB_VERSION = 1;
const KV = "kv";
const KEY_RECORD = "aes-key";
const SNAPSHOT_RECORD = "console-snapshot";
const FALLBACK_KEY = "benzo.console.state.key.fallback.v1";
const FALLBACK_SNAPSHOT = "benzo.console.state.encrypted.fallback.v1";
const AAD = "benzo.console.state.v1";
const WALLET_ORIGIN = "https://wallet.benzo.space";
const CONSOLE_ORIGIN = "https://console.benzo.space";

let memorySnapshot: ConsoleSnapshot | null = null;
let pending: Promise<ConsoleSnapshot> | null = null;

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSnapshot(seed: ConsoleSeed): ConsoleSnapshot {
  return {
    version: 1,
    savedAt: now(),
    session: clone(seed.session),
    accounts: clone(seed.accounts),
    members: clone(seed.members),
    counterparties: clone(seed.counterparties),
    payments: clone(seed.payments),
    payrolls: clone(seed.payrolls),
    invoices: clone(seed.invoices),
    grants: clone(seed.grants),
    policies: clone(seed.policies),
    invites: clone(seed.invites ?? []),
  };
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KV)) req.result.createObjectStore(KV);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, "readonly");
    const req = tx.objectStore(KV).get(key);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    req.onsuccess = () => resolve(req.result as T | undefined);
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KV, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.objectStore(KV).put(value, key);
  });
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function cryptoKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(KEY_RECORD);
  if (existing) return existing;
  if (hasIndexedDb()) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbSet(KEY_RECORD, key);
    return key;
  }
  let raw = localStorage.getItem(FALLBACK_KEY);
  if (!raw) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    raw = b64(bytes);
    localStorage.setItem(FALLBACK_KEY, raw);
  }
  return crypto.subtle.importKey("raw", bufferSource(unb64(raw)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSnapshot(snapshot: ConsoleSnapshot): Promise<{ iv: string; ciphertext: string; savedAt: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferSource(iv), additionalData: bufferSource(new TextEncoder().encode(AAD)) },
    await cryptoKey(),
    bufferSource(plaintext),
  ));
  return { iv: b64(iv), ciphertext: b64(encrypted), savedAt: snapshot.savedAt };
}

async function decryptSnapshot(record: { iv: string; ciphertext: string }): Promise<ConsoleSnapshot> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(unb64(record.iv)), additionalData: bufferSource(new TextEncoder().encode(AAD)) },
    await cryptoKey(),
    bufferSource(unb64(record.ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConsoleSnapshot;
}

async function readEncrypted(): Promise<ConsoleSnapshot | null> {
  const record = hasIndexedDb()
    ? await idbGet<{ iv: string; ciphertext: string }>(SNAPSHOT_RECORD)
    : JSON.parse(localStorage.getItem(FALLBACK_SNAPSHOT) || "null") as { iv: string; ciphertext: string } | null;
  if (!record) return null;
  try {
    return await decryptSnapshot(record);
  } catch {
    return null;
  }
}

async function writeEncrypted(snapshot: ConsoleSnapshot): Promise<void> {
  const record = await encryptSnapshot(snapshot);
  if (hasIndexedDb()) await idbSet(SNAPSHOT_RECORD, record);
  else localStorage.setItem(FALLBACK_SNAPSHOT, JSON.stringify(record));
}

export async function snapshot(loadSeed: () => Promise<ConsoleSeed>): Promise<ConsoleSnapshot> {
  if (memorySnapshot) return clone(memorySnapshot);
  if (pending) return clone(await pending);
  pending = (async () => {
    const existing = await readEncrypted();
    if (existing?.version === 1) {
      memorySnapshot = existing;
      return existing;
    }
    const initial = normalizeSnapshot(await loadSeed());
    memorySnapshot = initial;
    await writeEncrypted(initial);
    return initial;
  })();
  try {
    return clone(await pending);
  } finally {
    pending = null;
  }
}

async function mutate(loadSeed: () => Promise<ConsoleSeed>, fn: (s: ConsoleSnapshot) => void): Promise<ConsoleSnapshot> {
  const s = await snapshot(loadSeed);
  fn(s);
  s.savedAt = now();
  memorySnapshot = clone(s);
  await writeEncrypted(s);
  return clone(s);
}

function conditionMatches(policy: ApprovalPolicy, amount: bigint): boolean {
  return policy.conditions.every((c) => {
    if (c.field !== "amount") return true;
    const value = BigInt(String(c.value));
    if (c.operator === "gt") return amount > value;
    if (c.operator === "gte") return amount >= value;
    if (c.operator === "lt") return amount < value;
    if (c.operator === "lte") return amount <= value;
    if (c.operator === "eq") return amount === value;
    return true;
  });
}

function matchPolicy(policies: ApprovalPolicy[], amount: bigint): ApprovalPolicy | undefined {
  return policies.find((p) => conditionMatches(p, amount));
}

function progress(policy: ApprovalPolicy | undefined, approvals: Approval[] = []): ApprovalProgressView {
  if (!policy) return { required: false, steps: [], satisfied: true, nextRole: null, nextKind: null };
  const approved = approvals.filter((a) => a.decision === "approved");
  const haveAt = (i: number) => new Set(approved.filter((a) => a.stepIndex === i).map((a) => a.approverMemberId)).size;
  const steps: ApprovalProgressView["steps"] = policy.steps.map((s, i) => ({
    stepIndex: i,
    role: s.role,
    need: s.minApprovers,
    have: haveAt(i),
    satisfied: haveAt(i) >= s.minApprovers,
    kind: "approve" as const,
  }));
  if (policy.releaseGate) {
    const i = policy.steps.length;
    steps.push({
      stepIndex: i,
      role: policy.releaseGate.role,
      need: policy.releaseGate.minApprovers,
      have: haveAt(i),
      satisfied: haveAt(i) >= policy.releaseGate.minApprovers,
      kind: "release" as const,
    });
  }
  const next = steps.find((s) => !s.satisfied);
  return { required: true, steps, satisfied: !next, nextRole: next?.role ?? null, nextKind: next?.kind ?? null };
}

function recordApproval(s: ConsoleSnapshot, opts: {
  policy?: ApprovalPolicy;
  approvals: Approval[];
  proposerId: string;
  actorMemberId?: string;
  decision: "approved" | "denied";
  comment?: string;
  paymentOrderId?: string;
  payrollBatchId?: string;
}): { error?: string; progress: ApprovalProgressView } {
  const prog = progress(opts.policy, opts.approvals);
  if (!opts.policy || prog.satisfied) return { progress: prog };
  const step = prog.steps.find((x) => !x.satisfied);
  if (!step) return { progress: prog };
  const already = new Set(opts.approvals.filter((a) => a.stepIndex === step.stepIndex && a.decision === "approved").map((a) => a.approverMemberId));
  const eligible = s.members.filter((m) => m.role === step.role && m.id !== opts.proposerId && m.status === "active" && !already.has(m.id));
  const actor = opts.actorMemberId ? s.members.find((m) => m.id === opts.actorMemberId) : eligible[0];
  if (opts.decision === "approved") {
    if (!actor) return { error: `no eligible ${step.role} approver (the proposer cannot approve their own request)`, progress: prog };
    if (actor.id === opts.proposerId) return { error: "segregation of duties: the proposer cannot approve their own request", progress: prog };
    if (actor.role !== step.role) return { error: `this step requires a ${step.role}; ${actor.name ?? actor.email} is a ${actor.role}`, progress: prog };
    if (already.has(actor.id)) return { error: `${actor.name ?? actor.email} has already approved this step`, progress: prog };
  }
  opts.approvals.push({
    id: id("appr"),
    orgId: s.session.org.id,
    paymentOrderId: opts.paymentOrderId,
    payrollBatchId: opts.payrollBatchId,
    stepIndex: step.stepIndex,
    approverMemberId: actor?.id ?? opts.proposerId,
    decision: opts.decision,
    comment: opts.comment,
    at: now(),
  });
  return { progress: progress(opts.policy, opts.approvals) };
}

function parseRate(value: string): bigint | null {
  const clean = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,7})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
}

function parseRosterCsv(csv: string): { rows: Array<{ name: string; handle?: string; rate: string }>; errors: Array<{ line: number; error: string }> } {
  const rows: Array<{ name: string; handle?: string; rate: string }> = [];
  const errors: Array<{ line: number; error: string }> = [];
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let start = 0;
  if (lines[0]) {
    const cols = lines[0].split(",").map((c) => c.trim());
    const rate = cols.length >= 3 ? cols[2] : cols[1];
    if (!rate || parseRate(rate) === null) start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const name = cols[0];
    const three = cols.length >= 3;
    const handle = three ? cols[1] : "";
    const rate = parseRate((three ? cols[2] : cols[1]) ?? "");
    if (!name) errors.push({ line: i + 1, error: "missing name" });
    else if (rate === null) errors.push({ line: i + 1, error: `invalid rate for "${name}"` });
    else rows.push({ name, handle: handle ? (handle.startsWith("@") ? handle : `@${handle}`) : undefined, rate: rate.toString() });
  }
  return { rows, errors };
}

function applyHandle(cp: Counterparty, handle: string): void {
  const shielded = handle.startsWith("@") ? handle : `@${handle}`;
  cp.paymentAddress = {
    shielded,
    spendPub: cp.paymentAddress?.spendPub ?? `client-spend-${cp.id}`,
    viewPub: cp.paymentAddress?.viewPub ?? `client-view-${cp.id}`,
    mvkScalar: cp.paymentAddress?.mvkScalar ?? `client-mvk-${cp.id}`,
  };
}

function assembleDashboard(s: ConsoleSnapshot, treasury?: TreasuryView): DashboardSummary {
  const recentActivity = [
    ...s.payments.map((p) => ({ id: p.id, kind: "payment" as const, title: p.memo || "Private payment", status: p.status, amountLabel: "Private", at: p.updatedAt })),
    ...s.payrolls.map((p) => ({ id: p.id, kind: "payroll" as const, title: p.period, status: p.status, amountLabel: "Private", at: p.createdAt })),
    ...s.invoices.map((i) => ({ id: i.id, kind: "invoice" as const, title: i.number, status: i.status, amountLabel: "Private", at: i.createdAt })),
    ...s.grants.map((g) => ({ id: g.id, kind: "grant" as const, title: g.auditorName, status: g.status, amountLabel: "View key", at: g.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  return {
    totalPosition: treasury?.totalHidden ?? { amount: "0", assetCode: "USDC" },
    pendingApprovals: s.payments.filter((p) => p.status === "needs_approval").length,
    openInvoices: s.invoices.filter((i) => i.status === "open" || i.status === "overdue" || i.status === "partially_paid").length,
    scheduledPayrolls: s.payrolls.filter((p) => p.status === "needs_approval" || p.status === "approved" || p.status === "processing").length,
    recentActivity,
    live: treasury?.live ?? true,
  };
}

function makeInvite(s: ConsoleSnapshot, body: { kind: OrgInvite["kind"]; name?: string; email?: string; role?: string; handle?: string; counterpartyId?: string }): OrgInvite {
  const token = id("tok");
  const app = body.kind === "member" ? "business" : "consumer";
  const expiresAt = Math.floor(Date.now() / 1000) + 14 * 86_400;
  const raw = encodeBenzoLink(
    {
      type: "org",
      orgId: s.session.org.id,
      kind: body.kind,
      role: body.role,
      orgName: s.session.org.name,
      counterpartyId: body.counterpartyId,
      inviteeName: body.name ?? body.email,
      token,
      app,
      expiresAt: String(expiresAt),
    },
    "scheme",
  );
  const origin = app === "business" ? CONSOLE_ORIGIN : WALLET_ORIGIN;
  return {
    id: id("invite"),
    kind: body.kind,
    name: body.name,
    email: body.email,
    role: body.role,
    counterpartyId: body.counterpartyId,
    link: `${origin}/claim#${encodeURIComponent(raw)}`,
    token,
    status: "sent",
    createdAt: now(),
  };
}

function toHandle(s: ConsoleSnapshot, counterpartyId?: string): string | undefined {
  return s.counterparties.find((c) => c.id === counterpartyId)?.paymentAddress?.shielded;
}

export const localConsole = {
  async session(loadSeed: () => Promise<ConsoleSeed>) {
    return (await snapshot(loadSeed)).session;
  },
  async dashboard(loadSeed: () => Promise<ConsoleSeed>, treasury?: TreasuryView) {
    return assembleDashboard(await snapshot(loadSeed), treasury);
  },
  async accounts(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).accounts; },
  async members(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).members; },
  async counterparties(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).counterparties; },
  async payments(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).payments; },
  async payrolls(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).payrolls; },
  async invoices(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).invoices; },
  async grants(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).grants; },
  async policies(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).policies; },
  async invites(loadSeed: () => Promise<ConsoleSeed>) { return (await snapshot(loadSeed)).invites; },

  async updateCounterparty(loadSeed: () => Promise<ConsoleSeed>, counterpartyId: string, patch: { payRate?: string; status?: Counterparty["status"]; handle?: string; name?: string }) {
    let updated: Counterparty | undefined;
    await mutate(loadSeed, (s) => {
      const cp = s.counterparties.find((c) => c.id === counterpartyId);
      if (!cp) throw new Error("not found");
      if (patch.payRate !== undefined) {
        cp.payRate = { amount: patch.payRate, assetCode: "USDC" };
        cp.payCadence = "monthly";
      }
      if (patch.status) cp.status = patch.status;
      if (patch.name) cp.name = patch.name;
      if (patch.handle) applyHandle(cp, patch.handle);
      updated = clone(cp);
    });
    return updated!;
  },

  async importRoster(loadSeed: () => Promise<ConsoleSeed>, csv: string) {
    const parsed = parseRosterCsv(csv);
    let contractors: Counterparty[] = [];
    await mutate(loadSeed, (s) => {
      for (const row of parsed.rows) {
        let cp = s.counterparties.find((c) => c.name.toLowerCase() === row.name.toLowerCase());
        if (!cp) {
          cp = { id: id("cp"), orgId: s.session.org.id, name: row.name, type: "contractor", status: "pending_screening", externalAccounts: [], createdAt: now() };
          s.counterparties.push(cp);
        }
        cp.payRate = { amount: row.rate, assetCode: "USDC" };
        cp.payCadence = "monthly";
        if (row.handle) applyHandle(cp, row.handle);
      }
      contractors = clone(s.counterparties.filter((c) => c.type === "contractor"));
    });
    return { imported: parsed.rows.length, errors: parsed.errors, contractors };
  },

  async contractorHistory(loadSeed: () => Promise<ConsoleSeed>, counterpartyId: string) {
    const s = await snapshot(loadSeed);
    return s.payrolls.flatMap((b) => b.lines
      .filter((l) => l.counterpartyId === counterpartyId)
      .map((l) => ({ period: b.period, amount: l.amount, status: l.status, txHash: l.txHash, batchId: b.id })));
  },

  async createInvite(loadSeed: () => Promise<ConsoleSeed>, body: { kind: OrgInvite["kind"]; name?: string; email?: string; role?: string; handle?: string }) {
    let invite: OrgInvite | undefined;
    await mutate(loadSeed, (s) => {
      let counterpartyId: string | undefined;
      if (body.kind === "contractor" || body.kind === "customer") {
        const name = body.name ?? body.email ?? "New contractor";
        let cp = s.counterparties.find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (!cp) {
          cp = { id: id("cp"), orgId: s.session.org.id, name, type: body.kind === "customer" ? "customer" : "contractor", status: "pending_screening", externalAccounts: [], createdAt: now() };
          s.counterparties.push(cp);
        }
        if (body.handle) applyHandle(cp, body.handle);
        counterpartyId = cp.id;
      }
      if (body.kind === "member" && body.email) {
        s.members.push({ id: id("mem"), orgId: s.session.org.id, email: body.email, role: (body.role as Member["role"]) ?? "approver", status: "invited", createdAt: now() });
      }
      invite = makeInvite(s, { ...body, counterpartyId });
      s.invites.unshift(invite);
    });
    return invite!;
  },

  async bulkInvite(loadSeed: () => Promise<ConsoleSeed>, csv: string) {
    const parsed = parseRosterCsv(csv);
    let invites: OrgInvite[] = [];
    await mutate(loadSeed, (s) => {
      for (const row of parsed.rows) {
        let cp = s.counterparties.find((c) => c.name.toLowerCase() === row.name.toLowerCase());
        if (!cp) {
          cp = { id: id("cp"), orgId: s.session.org.id, name: row.name, type: "contractor", status: "pending_screening", externalAccounts: [], createdAt: now() };
          s.counterparties.push(cp);
        }
        cp.payRate = { amount: row.rate, assetCode: "USDC" };
        cp.payCadence = "monthly";
        if (row.handle) applyHandle(cp, row.handle);
        const invite = makeInvite(s, { kind: "contractor", name: row.name, counterpartyId: cp.id });
        s.invites.unshift(invite);
        invites.push(invite);
      }
    });
    return { created: invites.length, errors: parsed.errors, invites };
  },

  async revokeInvite(loadSeed: () => Promise<ConsoleSeed>, inviteId: string) {
    let invite: OrgInvite | undefined;
    await mutate(loadSeed, (s) => {
      invite = s.invites.find((i) => i.id === inviteId);
      if (!invite) throw new Error("not found");
      invite.status = "revoked";
    });
    return invite!;
  },

  async createPayment(loadSeed: () => Promise<ConsoleSeed>, body: {
    type: PaymentOrder["type"];
    fromAccountId: string;
    toCounterpartyId: string;
    amount: Money;
    memo?: string;
    ref?: string;
    toHandle?: string;
  }, settle: SettlementPayment) {
    let payment: PaymentOrder | undefined;
    const s0 = await snapshot(loadSeed);
    const policy = matchPolicy(s0.policies, BigInt(body.amount.amount));
    await mutate(loadSeed, (s) => {
      payment = {
        id: id("po"),
        orgId: s.session.org.id,
        type: body.type,
        status: policy ? "needs_approval" : "approved",
        amount: body.amount,
        fromAccountId: body.fromAccountId,
        toCounterpartyId: body.toCounterpartyId,
        memo: body.memo,
        ref: body.ref,
        approvalPolicyId: policy?.id,
        approvals: [],
        privacy: { amountHidden: true, counterpartyHidden: true, visibleTo: [s.session.member.id] },
        settlement: {},
        createdByMemberId: s.session.member.id,
        createdAt: now(),
        updatedAt: now(),
      };
      s.payments.unshift(payment);
    });
    if (!policy && payment) {
      const settled = await settle({ amount: payment.amount, toHandle: body.toHandle ?? toHandle(s0, body.toCounterpartyId), memo: body.memo });
      await mutate(loadSeed, (s) => {
        const p = s.payments.find((x) => x.id === payment!.id);
        if (!p) return;
        p.status = settled.onChain ? "confirmed" : "failed";
        p.settlement = { txHash: settled.txHash, onChain: settled.onChain, mode: settled.onChain ? "onchain" : "failed", nullifiers: settled.txHash ? [settled.txHash] : [] };
        p.updatedAt = now();
        payment = clone(p);
      });
    }
    return payment!;
  },

  async approvePayment(loadSeed: () => Promise<ConsoleSeed>, paymentId: string, body: { decision: "approved" | "denied"; actorMemberId?: string; comment?: string }, settle: SettlementPayment) {
    let payment: PaymentOrder | undefined;
    let result: ApprovalProgressView | undefined;
    let handle: string | undefined;
    await mutate(loadSeed, (s) => {
      const p = s.payments.find((x) => x.id === paymentId);
      if (!p) throw new Error("not found");
      const policy = s.policies.find((x) => x.id === p.approvalPolicyId);
      p.approvals = p.approvals ?? [];
      const r = recordApproval(s, { policy, approvals: p.approvals, proposerId: p.createdByMemberId, actorMemberId: body.actorMemberId, decision: body.decision, comment: body.comment, paymentOrderId: p.id });
      if (r.error) throw new Error(r.error);
      result = r.progress;
      if (body.decision === "denied") p.status = "cancelled";
      p.updatedAt = now();
      handle = toHandle(s, p.toCounterpartyId);
      payment = clone(p);
    });
    if (payment && body.decision === "approved" && result?.satisfied) {
      const settled = await settle({ amount: payment.amount, toHandle: handle, memo: payment.memo });
      await mutate(loadSeed, (s) => {
        const p = s.payments.find((x) => x.id === payment!.id);
        if (!p) return;
        p.status = settled.onChain ? "confirmed" : "failed";
        p.settlement = { txHash: settled.txHash, onChain: settled.onChain, mode: settled.onChain ? "onchain" : "failed", nullifiers: settled.txHash ? [settled.txHash] : [] };
        p.updatedAt = now();
        payment = clone(p);
      });
    }
    return { ...payment!, progress: result };
  },

  async createPayroll(loadSeed: () => Promise<ConsoleSeed>, body: { period: string; source: PayrollBatch["source"]; lines: Array<{ counterpartyId: string }>; scheduledAt?: string }) {
    let batch: PayrollBatch | undefined;
    await mutate(loadSeed, (s) => {
      const lines: PayrollLine[] = [];
      let total = 0n;
      for (const row of body.lines) {
        const cp = s.counterparties.find((c) => c.id === row.counterpartyId);
        const amount = cp?.payRate?.amount;
        if (!cp || !amount || BigInt(amount) <= 0n) {
          lines.push({ counterpartyId: row.counterpartyId, amount: "0", status: "failed", error: !cp ? "unknown contractor" : "no rate card set" });
        } else {
          total += BigInt(amount);
          lines.push({ counterpartyId: row.counterpartyId, amount, rate: amount, status: "pending" });
        }
      }
      const policy = matchPolicy(s.policies, total);
      batch = {
        id: id("pr"),
        orgId: s.session.org.id,
        period: body.period,
        source: body.source,
        status: policy ? "needs_approval" : "approved",
        lines,
        total: { amount: total.toString(), assetCode: "USDC" },
        approvals: [],
        scheduledAt: body.scheduledAt,
        createdAt: now(),
      };
      s.payrolls.unshift(batch);
    });
    return batch!;
  },

  async approvePayroll(loadSeed: () => Promise<ConsoleSeed>, payrollId: string, body: { decision?: "approved" | "denied"; actorMemberId?: string; comment?: string }, settle: SettlementPayroll) {
    let batch: PayrollBatch | undefined;
    let result: ApprovalProgressView | undefined;
    let settlementLines: Array<{ counterpartyId: string; amount: string; handle?: string }> = [];
    await mutate(loadSeed, (s) => {
      const b = s.payrolls.find((x) => x.id === payrollId);
      if (!b) throw new Error("not found");
      const policy = matchPolicy(s.policies, BigInt(b.total.amount));
      b.approvals = b.approvals ?? [];
      const r = recordApproval(s, { policy, approvals: b.approvals, proposerId: s.session.member.id, actorMemberId: body.actorMemberId, decision: body.decision ?? "approved", comment: body.comment, payrollBatchId: b.id });
      if (r.error) throw new Error(r.error);
      result = r.progress;
      if (body.decision === "denied") b.status = "cancelled";
      else if (!r.progress.satisfied) b.status = "needs_approval";
      settlementLines = b.lines.map((l) => ({ counterpartyId: l.counterpartyId, amount: l.amount, handle: toHandle(s, l.counterpartyId) }));
      batch = clone(b);
    });
    if (batch && (body.decision ?? "approved") === "approved" && result?.satisfied) {
      const settled = await settle({ lines: settlementLines });
      await mutate(loadSeed, (s) => {
        const b = s.payrolls.find((x) => x.id === batch!.id);
        if (!b) return;
        for (const line of b.lines) {
          const r = settled.lines.find((x) => x.counterpartyId === line.counterpartyId);
          if (!r) continue;
          line.status = r.status;
          line.txHash = r.txHash;
          line.onChain = r.onChain;
          line.error = r.error;
        }
        b.status = b.lines.every((l) => l.status === "paid" || (l.status === "failed" && BigInt(l.amount || "0") === 0n)) ? "completed" : "processing";
        batch = clone(b);
      });
    }
    return { ...batch!, progress: result };
  },

  async payInvoice(loadSeed: () => Promise<ConsoleSeed>, invoiceId: string, settle: SettlementPayment) {
    let invoice: Invoice | undefined;
    let payment: PaymentOrder | undefined;
    const s = await snapshot(loadSeed);
    const inv = s.invoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error("not found");
    payment = await localConsole.createPayment(loadSeed, {
      type: "invoice_payment",
      fromAccountId: "acc_op",
      toCounterpartyId: inv.counterpartyId,
      amount: inv.total,
      memo: `Pay ${inv.number}`,
      ref: inv.id,
    }, settle);
    await mutate(loadSeed, (state) => {
      const target = state.invoices.find((i) => i.id === invoiceId);
      if (!target) return;
      target.paymentOrderIds = [...(target.paymentOrderIds ?? []), payment!.id];
      if (payment!.status === "confirmed") target.status = "paid";
      invoice = clone(target);
    });
    return { invoice: invoice!, payment };
  },

  async createGrant(loadSeed: () => Promise<ConsoleSeed>, body: { auditorName: string; auditorPubKey: string; tier: ViewingGrant["tier"]; scope: ViewingGrant["scope"]; expiry: string }) {
    let grant: ViewingGrant | undefined;
    await mutate(loadSeed, (s) => {
      grant = {
        id: id("vg"),
        orgId: s.session.org.id,
        auditorName: body.auditorName,
        auditorPubKey: body.auditorPubKey,
        tier: body.tier,
        scope: body.scope,
        expiry: body.expiry,
        status: "active",
        portalUrl: `https://audit.benzo.space/g/${id("portal")}`,
        tvkCiphertext: `sealed:${id("tvk")}`,
        createdAt: now(),
      };
      s.grants.unshift(grant);
    });
    return grant!;
  },

  async revokeGrant(loadSeed: () => Promise<ConsoleSeed>, grantId: string) {
    let grant: ViewingGrant | undefined;
    await mutate(loadSeed, (s) => {
      grant = s.grants.find((g) => g.id === grantId);
      if (!grant) throw new Error("not found");
      grant.status = "revoked";
    });
    return grant!;
  },

  async updatePolicy(loadSeed: () => Promise<ConsoleSeed>, policyId: string, patch: Partial<Pick<ApprovalPolicy, "name" | "conditions" | "steps" | "releaseGate">>) {
    let policy: ApprovalPolicy | undefined;
    await mutate(loadSeed, (s) => {
      policy = s.policies.find((p) => p.id === policyId);
      if (!policy) throw new Error("not found");
      Object.assign(policy, patch);
    });
    return policy!;
  },

  async markPayrollProof(loadSeed: () => Promise<ConsoleSeed>, id: string, patch: Partial<PayrollBatch>) {
    await mutate(loadSeed, (s) => {
      const b = s.payrolls.find((x) => x.id === id);
      if (b) Object.assign(b, patch);
    });
  },
};

export async function localPayrollLines(loadSeed: () => Promise<ConsoleSeed>, id: string) {
  const s = await snapshot(loadSeed);
  const batch = s.payrolls.find((b) => b.id === id);
  if (!batch) throw new Error("not found");
  return {
    batch,
    lines: batch.lines.map((l) => ({ ...l, handle: toHandle(s, l.counterpartyId) })),
  };
}

export type PayrollProofResponses = {
  funded: { runTotal: string; funded: boolean; onChain: boolean; provenAt: string; ref?: OnChainRef };
  approval: { approved: boolean; onChain: boolean; approvers: number; threshold: number; memberCount: number; provenAt: string; ref?: OnChainRef };
  computation: { ok: boolean; onChain: boolean; runTotal: string; provenAt: string; ref?: OnChainRef };
  policy: { cap: string; lines: Array<{ counterpartyId: string; capProof?: { withinCap: boolean; onChain: boolean }; screenProof?: { innocent: boolean; onChain: boolean } }> };
};

export function __resetLocalConsoleMemoryForTests(): void {
  memorySnapshot = null;
  pending = null;
}
