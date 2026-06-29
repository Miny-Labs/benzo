/**
 * Payroll - confidential batch runs. Each batch hides individual salaries on-chain
 * (one shielded transfer per person) while the employer can still prove the total.
 * Approve runs the real per-recipient joinsplits on testnet.
 */
import { useState } from "react";
import { CheckCheck, Download, ShieldCheck, Users } from "lucide-react";
import { motion } from "framer-motion";
import type { PayrollBatch } from "@benzo/types";
import { api, type OnChainRef } from "../lib/api";
import { useConsole, useCounterpartyName } from "../lib/store";
import { explorerTxUrl, fmtUsd, friendlyError } from "../lib/format";
import { Page, Proving, Stagger } from "../ui/motion";
import { OnChainDetail } from "../ui/onchain";
import { Button, Card, EmptyState, Input, Modal, Pill, Skeleton, StatusPill, useToast } from "../ui/primitives";

export function Payroll() {
  const toast = useToast();
  const { payrolls, counterparties, masked, refresh, loading } = useConsole();
  const name = useCounterpartyName();
  // Count recipients with no on-chain payout material on file - those lines can't
  // settle privately, so the approver sees it BEFORE an irreversible run, not after.
  const unpayableCount = (b: PayrollBatch) =>
    b.lines.filter((l) => !counterparties.find((c) => c.id === l.counterpartyId)?.paymentAddress?.shielded).length;
  const hasFailedLines = (b: PayrollBatch) => b.lines.some((l) => l.status === "failed");
  const visiblePayrolls = [...payrolls].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const [busy, setBusy] = useState<string | null>(null);
  const [funding, setFunding] = useState<string | null>(null);
  const [policing, setPolicing] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [computing, setComputing] = useState<string | null>(null);
  const [cap, setCap] = useState("5000.00");
  const [open, setOpen] = useState<string | null>(null);
  // Confirm gate for the highest-value irreversible action (Approve & run).
  const [confirmRun, setConfirmRun] = useState<PayrollBatch | null>(null);
  // On-chain refs captured from this session's prove calls, keyed by batch id, so
  // each proof badge can offer a "see what happened on-chain" drill-down.
  const [refs, setRefs] = useState<Record<string, { funded?: OnChainRef; approval?: OnChainRef; computation?: OnChainRef }>>({});

  // Verifiable payroll computation (Z6) - prove the run total was COMPUTED from
  // the rate card (rate×period−deductions), on-chain (PAYCOMP), rate card private.
  async function checkComputation(b: PayrollBatch) {
    setComputing(b.id);
    try {
      const r = await api.proveComputation(b.id);
      if (r.ref) setRefs((m) => ({ ...m, [b.id]: { ...m[b.id], computation: r.ref } }));
      toast({
        title: r.ok ? `Run total verified as computed from the rate card${r.onChain ? " (on-chain)" : ""}` : "Could not verify computation",
        tone: r.ok ? "success" : "danger",
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setComputing(null);
    }
  }

  // Anonymous approver (Z5) - prove >= threshold distinct approvers signed this
  // run on-chain (ORGAUTH) WITHOUT revealing which. Surveillance-free dual control.
  async function checkApproval(b: PayrollBatch) {
    setApproving(b.id);
    try {
      const r = await api.proveApproval(b.id);
      if (r.ref) setRefs((m) => ({ ...m, [b.id]: { ...m[b.id], approval: r.ref } }));
      toast({
        title: r.approved
          ? `Approved ${r.approvers}-of-${r.memberCount}, members anonymous${r.onChain ? " (proven on-chain)" : ""}`
          : "Not enough approvers signed",
        tone: r.approved ? "success" : "danger",
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setApproving(null);
    }
  }

  // In-ZK spending policy (Z3) - prove EACH line is within the per-payout cap
  // on-chain (SPENDCAP), amounts hidden. Over-cap lines are provably blocked.
  async function checkPolicy(b: PayrollBatch) {
    setPolicing(b.id);
    setOpen(b.id);
    try {
      const r = await api.provePolicy(b.id, cap);
      const over = r.lines.filter((l) => l.capProof?.onChain && !l.capProof.withinCap).length;
      const flagged = r.lines.filter((l) => l.screenProof?.onChain && !l.screenProof.innocent).length;
      const unverified = r.lines.filter((l) => l.capProof && !l.capProof.onChain || l.screenProof && !l.screenProof.onChain).length;
      const problems = over + flagged + unverified;
      toast({
        title: problems
          ? [
              over ? `${over} over the ${cap} cap` : "",
              flagged ? `${flagged} sanctioned` : "",
              unverified ? `${unverified} proof${unverified === 1 ? "" : "s"} not verified on-chain` : "",
            ].filter(Boolean).join(", ")
          : `All lines within cap and clear of sanctions, proven on-chain`,
        tone: problems ? "danger" : "success",
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setPolicing(null);
    }
  }

  // "Payroll funded ✓" - prove ON-CHAIN (ORGBAL) the treasury covers this run's
  // total before anyone approves it. Reveals neither the treasury nor the total.
  async function checkFunded(b: PayrollBatch) {
    setFunding(b.id);
    try {
      const r = await api.proveFunded(b.id);
      if (r.ref) setRefs((m) => ({ ...m, [b.id]: { ...m[b.id], funded: r.ref } }));
      toast({
        title: r.onChain ? (r.funded ? "Funded, proven on-chain" : "Over budget. Treasury below run total.") : "Funded check was not verified on-chain",
        tone: r.onChain && r.funded ? "success" : "danger",
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setFunding(null);
    }
  }

  async function run(b: PayrollBatch) {
    setBusy(b.id);
    try {
      // One click = one approval step (proposer ≠ approver, enforced server-side);
      // the run settles only when every step + the release gate are satisfied.
      const updated = await api.approvePayroll(b.id);
      const prog = updated.progress;
      if (prog && !prog.satisfied) {
        toast({ title: `Approved · now needs ${prog.nextRole}${prog.nextKind === "release" ? " to release" : ""}`, tone: "success" });
      } else {
        const failed = updated.lines.filter((l) => l.status === "failed");
        const onChain = updated.lines.some((l) => l.onChain);
        toast({
          title: failed.length ? `${failed.length} line(s) failed. See details.` : onChain ? "Payroll paid" : "Payroll did not settle on-chain",
          tone: failed.length || !onChain ? "danger" : "success",
        });
        setOpen(b.id); // reveal per-line outcomes
      }
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const approvedCount = (b: PayrollBatch) => (b.approvals ?? []).filter((a) => a.decision === "approved").length;

  function download(name: string, text: string, type: string) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadPayslips(b: PayrollBatch) {
    const rows = b.lines.map((l) => ({
      period: b.period,
      contractor: name(l.counterpartyId),
      gross: l.amount,
      status: l.status,
      txHash: l.txHash,
      error: l.error,
    }));
    download(`benzo-payslips-${b.period}.json`, JSON.stringify(rows, null, 2), "application/json");
  }

  function exportCsv(b: PayrollBatch) {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["period", "contractor", "amount_stroops", "status", "tx_hash", "error"],
      ...b.lines.map((l) => [b.period, name(l.counterpartyId), l.amount, l.status, l.txHash ?? "", l.error ?? ""]),
    ];
    download(`benzo-payroll-${b.period}.csv`, rows.map((r) => r.map(esc).join(",")).join("\n"), "text/csv");
  }

  return (
    <Page>
      <div className="mb-5">
        <h1 className="font-display text-2xl">Payroll</h1>
        <p className="mt-1 text-[13.5px] text-muted">Salaries private on-chain · total provable to an auditor</p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i} className="p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-11 w-11 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-7 w-24" />
              </div>
            </Card>
          ))}
        </div>
      ) : payrolls.length === 0 ? (
        <EmptyState title="No payroll runs yet" hint="Connect your HR system or import a CSV to schedule a run." />
      ) : (
        <Stagger className="space-y-4">
          {visiblePayrolls.map((b, i) => {
            const proofRefs = refs[b.id];
            const proving =
              funding === b.id ? { steps: ["Reading the run total", "Proving the treasury covers it", "Verifying ORGBAL on-chain"] }
              : approving === b.id ? { steps: ["Gathering approver signatures", "Proving the threshold is met", "Verifying ORGAUTH on-chain"] }
              : computing === b.id ? { steps: ["Re-deriving from the rate card", "Proving the run total", "Verifying PAYCOMP on-chain"] }
              : policing === b.id ? { steps: ["Checking each line's cap", "Screening for sanctions", "Verifying every line on-chain"] }
              : null;
            return (
            <Stagger.Item key={b.id} index={i}>
              <Card className="p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Users size={20} />
                    </div>
                    <div>
                      <div className="text-[15px] font-semibold">{b.period} payroll</div>
                      <div className="text-[13px] text-muted">
                        {b.lines.length} {b.lines.length === 1 ? "person" : "people"} · via {b.source}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="font-display tnum text-xl font-semibold text-fg" data-testid="payroll-total">{masked ? "••••" : fmtUsd(b.total.amount)}</div>
                      <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
                        {/* Proof pills go green (shielded) ONLY when the proof actually verified on-chain. */}
                        {b.fundedProof ? (
                          <span className="inline-flex items-center gap-1" data-testid="funded-badge">
                            <Pill tone={!b.fundedProof.funded ? "danger" : b.fundedProof.onChain ? "shielded" : "warning"}>
                              <ShieldCheck size={11} /> {b.fundedProof.funded ? (b.fundedProof.onChain ? "Funded on-chain" : "Funding not verified on-chain") : "Over budget"}
                            </Pill>
                            {proofRefs?.funded ? <OnChainDetail refData={proofRefs.funded} label="" /> : null}
                          </span>
                        ) : null}
                        {b.approvalProof ? (
                          <span className="inline-flex items-center gap-1" data-testid="approval-badge">
                            <Pill tone={!b.approvalProof.approved ? "danger" : b.approvalProof.onChain ? "shielded" : "warning"}>
                              <ShieldCheck size={11} /> {b.approvalProof.approved ? `Approved ${b.approvalProof.approvers}-of-${b.approvalProof.memberCount} · anonymous${b.approvalProof.onChain ? "" : " · not verified on-chain"}` : "Not approved"}
                            </Pill>
                            {proofRefs?.approval ? <OnChainDetail refData={proofRefs.approval} label="" /> : null}
                          </span>
                        ) : null}
                        {b.computationProof ? (
                          <span className="inline-flex items-center gap-1" data-testid="computation-badge">
                            <Pill tone={!b.computationProof.ok ? "danger" : b.computationProof.onChain ? "shielded" : "warning"}>
                              <ShieldCheck size={11} /> {b.computationProof.ok ? (b.computationProof.onChain ? "Computed from rate card" : "Computation not verified on-chain") : "Computation unverified"}
                            </Pill>
                            {proofRefs?.computation ? <OnChainDetail refData={proofRefs.computation} label="" /> : null}
                          </span>
                        ) : null}
                        {b.status === "needs_approval" && approvedCount(b) > 0 ? (
                          <span className="text-[11px] font-semibold text-[#9a6b12]">{approvedCount(b)} approved · needs more</span>
                        ) : null}
                        {b.status === "processing" && hasFailedLines(b) ? (
                          <Pill tone="danger">failed payouts</Pill>
                        ) : (
                          <StatusPill status={b.status} />
                        )}
                      </div>
                    </div>
                    {b.status === "needs_approval" || b.status === "approved" || b.status === "processing" ? (
                      <Button loading={busy === b.id} onClick={() => setConfirmRun(b)} data-testid="run-payroll">
                        <CheckCheck size={15} /> {b.status === "processing" ? "Retry failed" : "Approve & run"}
                      </Button>
                    ) : (
                      <Button variant="ghost" onClick={() => setOpen(open === b.id ? null : b.id)}>
                        {open === b.id ? "Hide" : "Details"}
                      </Button>
                    )}
                  </div>
                </div>

                {b.status === "needs_approval" || b.status === "approved" || b.status === "processing" ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4" data-testid="zk-controls">
                    <div className="w-24">
                      <Input aria-label="Per-payout cap (USDC)" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="payout-cap" />
                    </div>
                    <Button variant="outline" loading={policing === b.id} onClick={() => checkPolicy(b)} data-testid="check-policy">
                      <ShieldCheck size={15} /> Check policy
                    </Button>
                    <Button variant="outline" loading={approving === b.id} onClick={() => checkApproval(b)} data-testid="check-approval">
                      <ShieldCheck size={15} /> Anonymous approval
                    </Button>
                    <Button variant="outline" loading={computing === b.id} onClick={() => checkComputation(b)} data-testid="check-computation">
                      <ShieldCheck size={15} /> Verify computation
                    </Button>
                    <Button variant="outline" loading={funding === b.id} onClick={() => checkFunded(b)} data-testid="check-funded">
                      <ShieldCheck size={15} /> Check funded
                    </Button>
                    {b.status === "processing" && hasFailedLines(b) ? (
                      <span className="text-[12px] font-semibold text-danger" data-testid="payroll-failed-note">
                        This run did not settle. Fix the failed line, then retry.
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {proving ? (
                  <div className="mt-3 flex justify-end" data-testid="payroll-proving">
                    <Proving steps={proving.steps} />
                  </div>
                ) : null}

                {open === b.id ? (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="mt-4 overflow-hidden border-t border-border pt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[12px] font-semibold uppercase tracking-[0.05em] text-muted">Run register</span>
                      <div className="flex items-center gap-4">
                        <button onClick={() => downloadPayslips(b)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline" data-testid="download-payslips">
                          <Download size={13} /> Payslips
                        </button>
                        <button onClick={() => exportCsv(b)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline" data-testid="export-csv">
                          <Download size={13} /> Export CSV
                        </button>
                      </div>
                    </div>
                    {b.lines.map((l, li) => (
                      <div key={li} className="flex items-center gap-3 py-2 text-[13.5px]">
                        <span className="w-40 truncate">{name(l.counterpartyId)}</span>
                        <span className="flex-1 text-[12px] text-danger">{l.status === "failed" && l.error ? l.error : ""}</span>
                        {l.capProof ? (
                          <Pill tone={!l.capProof.onChain ? "warning" : !l.capProof.withinCap ? "danger" : "shielded"}>
                            <ShieldCheck size={10} /> {!l.capProof.onChain ? "cap not verified on-chain" : l.capProof.withinCap ? "within cap" : "over cap"}
                          </Pill>
                        ) : null}
                        {l.screenProof ? (
                          <Pill tone={!l.screenProof.onChain ? "warning" : !l.screenProof.innocent ? "danger" : "shielded"}>
                            <ShieldCheck size={10} /> {!l.screenProof.onChain ? "screening not verified on-chain" : l.screenProof.innocent ? "not sanctioned" : "sanctioned"}
                          </Pill>
                        ) : null}
                        {l.txHash ? (
                          <a href={explorerTxUrl(l.txHash)} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-primary hover:underline">receipt</a>
                        ) : null}
                        {l.status === "paid" && !l.onChain ? (
                          <Pill tone="warning">not settled on-chain</Pill>
                        ) : (
                          <Pill tone={l.status === "paid" ? "success" : l.status === "failed" ? "danger" : "warning"}>{l.status}</Pill>
                        )}
                        <span className="font-display tnum w-24 text-right font-semibold text-fg">{masked ? "••••" : fmtUsd(l.amount)}</span>
                      </div>
                    ))}
                  </motion.div>
                ) : null}
              </Card>
            </Stagger.Item>
            );
          })}
        </Stagger>
      )}

      <Modal
        open={!!confirmRun}
        onClose={() => setConfirmRun(null)}
        title={confirmRun?.status === "processing" ? "Retry failed payouts" : "Approve & run this payroll"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRun(null)}>Cancel</Button>
            <Button
              loading={!!confirmRun && busy === confirmRun.id}
              onClick={() => {
                const b = confirmRun;
                if (!b) return;
                setConfirmRun(null);
                void run(b);
              }}
              data-testid="run-payroll-confirm"
            >
              <CheckCheck size={15} /> {confirmRun?.status === "processing" ? "Retry failed" : "Approve & run"}
            </Button>
          </>
        }
      >
        {confirmRun ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              This is your approval step for the <b>{confirmRun.period}</b> run. If it's the final required step, it settles real on-chain payouts and <b>can't be undone</b>.
            </p>
            <div className="space-y-2 rounded-xl bg-canvas p-4 text-[14px]">
              <div className="flex justify-between"><span className="text-muted">Recipients</span><span className="font-semibold">{confirmRun.lines.length}</span></div>
              <div className="flex justify-between"><span className="text-muted">Total</span><span className="font-display tnum font-semibold">{masked ? "••••" : fmtUsd(confirmRun.total.amount)}</span></div>
            </div>
            {unpayableCount(confirmRun) > 0 ? (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[12.5px] text-[#9a6b12]">
                {unpayableCount(confirmRun)} recipient{unpayableCount(confirmRun) === 1 ? "" : "s"} {unpayableCount(confirmRun) === 1 ? "has" : "have"} no payout handle on file - those lines won't settle on-chain until they're invited.
              </div>
            ) : null}
            <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
              <ShieldCheck size={13} className="text-primary" /> Each salary stays private on-chain. Proposer ≠ approver is enforced server-side.
            </div>
          </div>
        ) : null}
      </Modal>
    </Page>
  );
}
