/**
 * Auditor grants — issue a scoped viewing key so an auditor sees exactly the
 * in-scope notes (a corridor/period), nothing else, and revoke it on-chain. This
 * is the two-sided compliance story: private by default, disclosable on your terms.
 */
import { useState } from "react";
import { Download, Eye, FileCheck, Plus, ShieldCheck, XCircle } from "lucide-react";
import type { DisclosureTier } from "@benzo/types";
import { api, type OnChainRef } from "../lib/api";
import { useConsole } from "../lib/store";
import { fmtUsd, formatDate, friendlyError } from "../lib/format";
import { Page, Proving, Reveal, Stagger } from "../ui/motion";
import { OnChainDetail } from "../ui/onchain";
import { Button, Card, EmptyState, Input, Modal, Pill, Select, Skeleton, StatusPill, useToast } from "../ui/primitives";

type PeriodTotal = Awaited<ReturnType<typeof api.periodTotalAttestation>>;

export function Grants() {
  const toast = useToast();
  const { grants, accounts, refresh, loading } = useConsole();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ auditorName: "", auditorPubKey: "", tier: "outgoing" as DisclosureTier, label: "2026-Q2", accountId: "" });
  const [period, setPeriod] = useState("2026-Q2");
  const [busyAtt, setBusyAtt] = useState(false);
  const [att, setAtt] = useState<PeriodTotal | null>(null);
  const [busyKyb, setBusyKyb] = useState(false);
  const [kyb, setKyb] = useState<{ ok: boolean; onChain: boolean; jurisdiction: string; tier: string; ref?: OnChainRef } | null>(null);
  // Confirm gate for an irreversible on-chain revoke that cuts auditor access.
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; auditorName: string } | null>(null);
  const [revoking, setRevoking] = useState(false);

  // KYB-as-ZK credential (Z7) — prove "verified business, jurisdiction Y, tier Z"
  // on-chain (KYB) without revealing any documents; sybil-resistant.
  async function proveKyb() {
    setBusyKyb(true);
    setKyb(null);
    try {
      const r = await api.proveKyb();
      setKyb(r);
      toast({ title: r.ok ? (r.onChain ? "KYB credential proven on-chain" : "KYB proof generated") : "Could not prove KYB", tone: r.ok ? "success" : "danger" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusyKyb(false);
    }
  }

  // Records export (Z2): generate a network-verified period-total attestation —
  // a real ORGSUM proof the auditor/tax office can re-verify on-chain. The
  // individual salaries that make up the total are never disclosed.
  async function exportPeriodTotal() {
    setBusyAtt(true);
    setAtt(null);
    try {
      const r = await api.periodTotalAttestation(period);
      setAtt(r);
      if (!r.live) toast({ title: "Not connected. Connect to generate a real attestation.", tone: "muted" });
      else toast({ title: r.onChain ? "Total proven on-chain" : "Attestation generated (demo)", tone: "success" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusyAtt(false);
    }
  }

  function downloadAttestation() {
    if (!att) return;
    const blob = new Blob([JSON.stringify(att, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `benzo-period-total-${att.period ?? period}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function create() {
    setBusy(true);
    try {
      await api.createGrant({
        auditorName: form.auditorName || "External Auditor",
        auditorPubKey: form.auditorPubKey || "0xaud",
        tier: form.tier,
        scope: { accountIds: form.accountId ? [form.accountId] : [], from: null, to: null, label: form.label },
        expiry: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      });
      toast({ title: "Viewing grant issued", tone: "success" });
      setOpen(false);
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(true);
    try {
      await api.revokeGrant(id);
      toast({ title: "Grant revoked", tone: "muted" });
      setConfirmRevoke(null);
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setRevoking(false);
    }
  }

  // The attestation already carries everything needed to re-verify the ORGSUM
  // proof on-chain (the "P0 irony" the audit flagged: the data was there, the
  // drill-down wasn't). Surface it as an OnChainRef.
  const attRef: OnChainRef | undefined =
    att?.live && att.vkId
      ? {
          label: `Period total · ${att.period ?? period}`,
          vkId: att.vkId,
          verified: !!att.onChain,
          verifier: att.verifier,
          network: att.network,
          root: att.root,
          publics: (att.sorobanPublics ?? []).map((v, i) => ({ k: i === 0 ? "Total (committed)" : `public[${i}]`, v })),
        }
      : undefined;

  return (
    <Page>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="font-display text-2xl">Auditor grants</h1>
          <p className="mt-1 text-[13.5px] text-muted">Read-only access for auditors. They see exactly what you grant, and nothing else.</p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="new-grant">
          <Plus size={15} /> New grant
        </Button>
      </div>

      <Card className="mb-5 p-5">
        <div className="flex items-center gap-2 text-[14px] font-semibold">
          <FileCheck size={16} className="text-primary" /> Period total for tax / audit
        </div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
          Export a network-verified statement of what you paid out for a period, e.g. "Q2 = $X." The total is proven on-chain; the individual salaries behind it stay hidden. The file embeds the proof so your auditor can re-verify it independently.
        </p>
        <p className="mt-1.5 max-w-2xl text-[11.5px] leading-relaxed text-muted/80">
          Soundness: this proves the disclosed notes sum to the stated total — not that the set is complete. It attests the total you claim, it does not detect a payout deliberately left out (completeness is bounded only by the authorized-key registry).
        </p>
        <div className="mt-4 flex items-end gap-3">
          <div className="w-48">
            <Input label="Period" placeholder="2026-Q2" value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="att-period" />
          </div>
          {busyAtt ? (
            <Proving steps={["Loading the period's notes", "Folding the ORGSUM proof", "Verifying the total on-chain"]} />
          ) : (
            <Button onClick={exportPeriodTotal} data-testid="gen-period-total">
              <ShieldCheck size={15} /> Generate
            </Button>
          )}
        </div>
        {att?.live ? (
          <Reveal tone="success" className="mt-4 rounded-lg border border-success/30 bg-success/8 px-4 py-3" data-testid="period-total-result">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1d7a52]">
              <ShieldCheck size={14} /> {att.period}: {fmtUsd(att.total ?? "0")}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {att.onChain ? "The network verified this total against the ORGSUM proof — proven, not asserted." : "Demo proof (not live)."} No single salary is revealed.
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button variant="outline" onClick={downloadAttestation} data-testid="download-attestation">
                <Download size={14} /> Download attestation (.json)
              </Button>
              {attRef ? <OnChainDetail refData={attRef} /> : null}
            </div>
          </Reveal>
        ) : null}
      </Card>

      <Card className="mb-5 p-5">
        <div className="flex items-center gap-2 text-[14px] font-semibold">
          <ShieldCheck size={16} className="text-primary" /> KYB credential (zero-knowledge)
        </div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
          Prove your business is verified, in a given jurisdiction and tier, to a counterparty or marketplace, without handing over a single document. The proof is checked on-chain and a one-time nullifier stops it being reused to spin up fake entities.
        </p>
        {busyKyb ? (
          <div className="mt-4">
            <Proving steps={["Building the KYB witness", "Proving the credential", "Checking it on-chain"]} />
          </div>
        ) : (
          <Button className="mt-4" onClick={proveKyb} data-testid="prove-kyb">
            <ShieldCheck size={15} /> Prove KYB credential
          </Button>
        )}
        {kyb?.ok ? (
          <Reveal tone="success" className="mt-4 rounded-lg border border-success/30 bg-success/8 px-4 py-3" data-testid="kyb-result">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1d7a52]">
              <ShieldCheck size={14} /> Verified business · {kyb.jurisdiction} · tier {kyb.tier}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {kyb.onChain ? "The network verified the credential. No documents were disclosed." : "Demo proof (not live)."}
            </div>
            {kyb.ref ? <div className="mt-3"><OnChainDetail refData={kyb.ref} /></div> : null}
          </Reveal>
        ) : null}
      </Card>

      {loading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i} className="flex items-center gap-4 p-5">
              <Skeleton className="h-11 w-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </Card>
          ))}
        </div>
      ) : grants.length === 0 ? (
        <EmptyState title="No grants yet" hint="Give an auditor read-only access to a specific period or account, and nothing else." />
      ) : (
        <Stagger className="space-y-4">
          {grants.map((g, i) => (
            <Stagger.Item key={g.id} index={i}>
              <Card className="flex items-center gap-4 p-5">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Eye size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[15px] font-semibold">
                    <span className="truncate">{g.auditorName}</span>
                    <Pill tone="shielded">{g.tier}</Pill>
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-muted">
                    Scope: {g.scope.label ?? "All activity"} · expires {formatDate(g.expiry)}
                  </div>
                </div>
                <StatusPill status={g.status} />
                {g.status === "active" ? (
                  <Button variant="outline" onClick={() => setConfirmRevoke({ id: g.id, auditorName: g.auditorName })} data-testid="revoke-grant">
                    <XCircle size={15} /> Revoke
                  </Button>
                ) : null}
              </Card>
            </Stagger.Item>
          ))}
        </Stagger>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Issue a viewing grant"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={create} data-testid="grant-submit">
              <ShieldCheck size={15} /> Issue grant
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Auditor name" placeholder="External Auditor" value={form.auditorName} onChange={(e) => setForm({ ...form, auditorName: e.target.value })} data-testid="grant-name" />
          <Input label="Auditor public key" placeholder="0x…" value={form.auditorPubKey} onChange={(e) => setForm({ ...form, auditorPubKey: e.target.value })} />
          <Select label="Disclosure tier" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value as DisclosureTier })}>
            <option value="outgoing">Outgoing only</option>
            <option value="incoming">Incoming only</option>
            <option value="full">Full</option>
          </Select>
          <Input label="What this covers" placeholder="Q2 payroll" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <Select label="Account scope" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
      </Modal>

      <Modal
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke this viewing grant"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
            <Button variant="danger" loading={revoking} onClick={() => confirmRevoke && revoke(confirmRevoke.id)} data-testid="revoke-grant-confirm">
              <XCircle size={15} /> Revoke access
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          This revokes <b>{confirmRevoke?.auditorName}</b>'s read-only access on-chain, immediately. They'll lose visibility into the granted scope and you can't undo it — you'd have to issue a new grant.
        </p>
      </Modal>
    </Page>
  );
}
