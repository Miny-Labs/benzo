/**
 * Contractors - the roster + rate cards that the pay engine COMPUTES runs from.
 * This is the input to every payroll run: a managed payee book with a monthly USDC
 * rate per contractor, CSV import, and a one-click "run this month" that assembles
 * a run whose amounts are computed server-side from these rates (never typed in).
 */
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Clock, Play, Upload } from "lucide-react";
import type { Counterparty } from "@benzo/types";
import { api } from "../lib/api";
import { useConsole } from "../lib/store";
import { explorerTxUrl, fmtUsd, friendlyError } from "../lib/format";
import { EASE, Page, Stagger, motion } from "../ui/motion";
import { Button, Card, EmptyState, Input, Modal, Pill, Skeleton, StatusPill, useToast } from "../ui/primitives";

type PayEvent = { period: string; amount: string; status: string; txHash?: string; batchId: string };

const period = () => new Date().toISOString().slice(0, 7); // e.g. 2026-06
const statuses: Counterparty["status"][] = ["draft", "invited", "pending_screening", "allowlisted", "blocked"];

export function Contractors() {
  const toast = useToast();
  const nav = useNavigate();
  const { counterparties, loading, refresh } = useConsole();
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [importErrors, setImportErrors] = useState<Array<{ line: number; error: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [rateEdits, setRateEdits] = useState<Record<string, string>>({});
  const [handleEdits, setHandleEdits] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, PayEvent[]>>({});
  const [histBusy, setHistBusy] = useState<string | null>(null);

  async function toggleHistory(c: Counterparty) {
    if (histOpen === c.id) return setHistOpen(null);
    setHistOpen(c.id);
    if (hist[c.id]) return;
    setHistBusy(c.id);
    try {
      const r = await api.contractorHistory(c.id);
      setHist((m) => ({ ...m, [c.id]: r }));
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setHistBusy(null);
    }
  }

  const contractors = useMemo(() => counterparties.filter((c) => c.type === "contractor"), [counterparties]);
  const payable = contractors.filter((c) => c.payRate && c.status === "allowlisted");
  const monthlyTotal = payable.reduce((s, c) => s + BigInt(c.payRate?.amount ?? "0"), 0n).toString();

  async function doImport() {
    setBusy("import");
    try {
      const r = await api.importRoster(csv);
      setImportErrors(r.errors);
      toast({
        title: `Imported ${r.imported} contractor${r.imported === 1 ? "" : "s"}${r.errors.length ? ` · ${r.errors.length} row error(s)` : ""}`,
        tone: r.errors.length ? "danger" : "success",
      });
      if (r.errors.length === 0) setImportOpen(false);
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function saveRate(c: Counterparty) {
    const human = rateEdits[c.id];
    if (human === undefined) return;
    setBusy(c.id);
    try {
      const stroops = (BigInt(Math.round(Number(human.replace(/[$,]/g, "")) * 1e7)) || 0n).toString();
      await api.updateCounterparty(c.id, { payRate: stroops });
      toast({ title: `Rate updated for ${c.name}`, tone: "success" });
      setSavedFlash(c.id);
      setTimeout(() => setSavedFlash((id) => (id === c.id ? null : id)), 900);
      setRateEdits((m) => {
        const n = { ...m };
        delete n[c.id];
        return n;
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function saveHandle(c: Counterparty) {
    const handle = handleEdits[c.id]?.trim();
    if (!handle) return;
    setBusy(c.id);
    try {
      await api.updateCounterparty(c.id, { handle: handle.startsWith("@") ? handle : `@${handle}` });
      toast({ title: `Handle updated for ${c.name}`, tone: "success" });
      setSavedFlash(c.id);
      setTimeout(() => setSavedFlash((id) => (id === c.id ? null : id)), 900);
      setHandleEdits((m) => {
        const n = { ...m };
        delete n[c.id];
        return n;
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function saveStatus(c: Counterparty, status: Counterparty["status"]) {
    if (status === c.status) return;
    setBusy(c.id);
    try {
      await api.updateCounterparty(c.id, { status });
      toast({ title: `Status updated for ${c.name}`, tone: "success" });
      setSavedFlash(c.id);
      setTimeout(() => setSavedFlash((id) => (id === c.id ? null : id)), 900);
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function runPayroll() {
    if (payable.length === 0) return;
    setBusy("run");
    try {
      // Amounts are COMPUTED server-side from each rate card - we only choose who's in.
      const batch = await api.createPayroll({
        period: period(),
        source: "manual",
        lines: payable.map((c) => ({ counterpartyId: c.id })),
      });
      toast({ title: `${period()} run drafted: ${batch.lines.length} contractors · ${fmtUsd(batch.total.amount)}`, tone: "success" });
      await refresh();
      nav("/payroll");
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="font-display text-2xl">Contractors</h1>
          <p className="mt-1 text-[13.5px] text-muted">Your payee book with rate cards. Every run is computed from these, never typed in.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)} data-testid="import-roster">
            <Upload size={15} /> Import CSV
          </Button>
          <Button onClick={runPayroll} loading={busy === "run"} disabled={payable.length === 0} data-testid="run-month">
            <Play size={15} /> Run {period()} payroll
          </Button>
        </div>
      </div>

      <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Stagger.Item index={0} className="h-full">
          <Card className="h-full p-4">
            <div className="text-xs uppercase tracking-wide text-muted">Active contractors</div>
            <div className="font-display mt-1 text-2xl tabular-nums">{payable.length}</div>
          </Card>
        </Stagger.Item>
        <Stagger.Item index={1} className="h-full">
          <Card className="h-full p-4">
            <div className="text-xs uppercase tracking-wide text-muted">Monthly run total</div>
            <div className="font-display mt-1 text-2xl tabular-nums">{fmtUsd(monthlyTotal)}</div>
          </Card>
        </Stagger.Item>
      </Stagger>
      <p className="mb-4 mt-2 text-[12.5px] text-muted">
        <span className="font-semibold text-fg">Computed, not typed.</span> Every line's gross comes from its rate card, computed on the server.
      </p>

      {loading ? (
        <Card className="overflow-hidden p-0">
          <div className="divide-y divide-border">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="ml-auto h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </Card>
      ) : contractors.length === 0 ? (
        <EmptyState title="No contractors yet" hint="Import a CSV (name, @handle, monthly USDC) to load your roster." />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Contractor", "Monthly rate", "Handle", "Tax form", "Status", ""].map((h, i) => (
                    <th key={i} className="bg-bg px-5 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.05em] text-[#a3a7ac]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contractors.map((c) => {
                  const editing = rateEdits[c.id] !== undefined;
                  const editingHandle = handleEdits[c.id] !== undefined;
                  const events = hist[c.id];
                  return (
                    <Fragment key={c.id}>
                    <tr className="transition hover:bg-[#f4f3ef]/60" data-testid="contractor-row">
                      <td className="border-t border-border px-5 py-3 font-medium text-fg"><span className="block max-w-[220px] truncate">{c.name}</span></td>
                      <td className="border-t border-border px-5 py-3">
                        <motion.div
                          className="-mx-2 inline-block rounded-md px-2"
                          animate={{ backgroundColor: savedFlash === c.id ? "rgba(34,197,94,0.18)" : "rgba(34,197,94,0)" }}
                          transition={{ duration: 0.45, ease: EASE }}
                        >
                          {editing ? (
                            <input
                              autoFocus
                              value={rateEdits[c.id]}
                              onChange={(e) => setRateEdits((m) => ({ ...m, [c.id]: e.target.value.replace(/[^0-9.]/g, "") }))}
                              onKeyDown={(e) => e.key === "Enter" && saveRate(c)}
                              onBlur={() => saveRate(c)}
                              data-testid="contractor-rate-input"
                              className="w-28 rounded-md border border-primary bg-bg px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary/20"
                            />
                          ) : (
                            <button
                              className="rounded font-display tabular-nums text-[15px] text-fg outline-none transition hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                              onClick={() => setRateEdits((m) => ({ ...m, [c.id]: c.payRate ? (Number(c.payRate.amount) / 1e7).toString() : "" }))}
                              title="Click to edit rate"
                              data-testid="contractor-rate-edit"
                            >
                              {c.payRate ? fmtUsd(c.payRate.amount) : <span className="text-danger">set rate</span>}
                              <span className="ml-1 text-[11px] text-muted">/mo</span>
                            </button>
                          )}
                        </motion.div>
                      </td>
                      <td className="border-t border-border px-5 py-3">
                        <motion.div
                          className="-mx-2 inline-flex items-center gap-1 rounded-md px-2"
                          animate={{ backgroundColor: savedFlash === c.id ? "rgba(34,197,94,0.18)" : "rgba(34,197,94,0)" }}
                          transition={{ duration: 0.45, ease: EASE }}
                        >
                          {editingHandle ? (
                            <>
                              <input
                                autoFocus
                                value={handleEdits[c.id]}
                                onChange={(e) => setHandleEdits((m) => ({ ...m, [c.id]: e.target.value.replace(/[^a-zA-Z0-9_@.-]/g, "") }))}
                                onKeyDown={(e) => e.key === "Enter" && saveHandle(c)}
                                data-testid="contractor-handle-input"
                                className="w-32 rounded-md border border-primary bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:ring-2 focus:ring-primary/20"
                              />
                              <button
                                onClick={() => saveHandle(c)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-panel text-muted transition hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                                title="Save handle"
                                data-testid="contractor-handle-save"
                              >
                                <Check size={14} />
                              </button>
                            </>
                          ) : (
                            <button
                              className="rounded font-mono text-[12px] text-fg outline-none transition hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                              onClick={() => setHandleEdits((m) => ({ ...m, [c.id]: c.paymentAddress?.shielded ?? "@" }))}
                              title="Click to edit handle"
                              data-testid="contractor-handle-edit"
                            >
                              {c.paymentAddress?.shielded ?? <span className="font-sans text-danger">set handle</span>}
                            </button>
                          )}
                        </motion.div>
                      </td>
                      <td className="border-t border-border px-5 py-3">
                        <Pill tone={c.taxFormType && c.taxFormType !== "none" ? "success" : "warning"}>{c.taxFormType ?? "none"}</Pill>
                      </td>
                      <td className="border-t border-border px-5 py-3">
                        <div className="flex flex-col gap-1">
                          <StatusPill status={c.status} />
                          <select
                            value={c.status}
                            onChange={(e) => saveStatus(c, e.target.value as Counterparty["status"])}
                            className="w-36 rounded-md border border-border bg-panel px-2 py-1 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                            data-testid="contractor-status-select"
                          >
                            {statuses.map((s) => (
                              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="border-t border-border px-5 py-3 text-right">
                        {busy === c.id ? (
                          <span className="text-[12px] text-muted">saving…</span>
                        ) : (
                          <button onClick={() => toggleHistory(c)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-muted transition hover:text-primary" data-testid="contractor-history">
                            <Clock size={13} /> {histOpen === c.id ? "Hide" : "History"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {histOpen === c.id ? (
                        <tr data-testid="contractor-history-row">
                          <td colSpan={6} className="border-t border-border bg-[#faf9f6] px-5 py-3">
                            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
                              {histBusy === c.id ? (
                                <div className="text-[12px] text-muted">Loading pay history…</div>
                              ) : !events || events.length === 0 ? (
                                <div className="text-[12px] text-muted">No payments to {c.name} yet. Runs that include them will show here with on-chain receipts.</div>
                              ) : (
                                <div className="space-y-1.5">
                                  {events.map((e, ei) => (
                                    <div key={ei} className="flex items-center gap-3 text-[12.5px]">
                                      <span className="w-20 font-medium text-fg">{e.period}</span>
                                      <StatusPill status={e.status} />
                                      {e.txHash ? (
                                        <a href={explorerTxUrl(e.txHash)} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-primary hover:underline">on-chain receipt</a>
                                      ) : null}
                                      <span className="font-display ml-auto tabular-nums text-fg">{fmtUsd(e.amount)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </motion.div>
                          </td>
                        </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={importOpen}
        onClose={() => {
          setImportErrors([]);
          setImportOpen(false);
        }}
        title="Import contractor roster"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setImportErrors([]);
                setImportOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button loading={busy === "import"} onClick={doImport} disabled={!csv.trim()} data-testid="import-submit"><Upload size={15} /> Import</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] text-muted">Paste CSV: <code className="rounded bg-bg px-1">name, @handle, monthly USDC</code>. Bad rows are flagged, never silently dropped.</div>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"Name,Handle,Monthly USDC\nContractor Name,@handle,2500"}
            rows={7}
            data-testid="import-csv"
            className="w-full rounded-lg border border-border bg-bg p-3 font-mono text-[12.5px] outline-none focus:border-primary"
          />
          {importErrors.length ? (
            <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[12.5px] text-[#b4232a]" data-testid="import-errors">
              <div className="mb-1 font-semibold">Fix these rows, then import again.</div>
              <ul className="space-y-1">
                {importErrors.map((err, idx) => (
                  <li key={`${err.line}-${idx}`}>Line {err.line}: {err.error}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Modal>
    </Page>
  );
}
