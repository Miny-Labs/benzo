/**
 * Invoices to pay (AP) — the second front-door into the pay engine. Contractor-
 * submitted invoices land here; "Pay" runs them through the SAME maker-checker +
 * confidential settlement as a payroll run (over the policy threshold → Approvals
 * first). One engine, two front-doors: employer-pushed runs and contractor invoices.
 */
import { useEffect, useMemo, useState } from "react";
import { FileText, Send, Wallet, ShieldCheck } from "lucide-react";
import type { Invoice } from "@benzo/types";
import { api, type OnChainRef } from "../lib/api";
import { useConsole } from "../lib/store";
import { fmtUsd, formatDate, friendlyError } from "../lib/format";
import { statusMeta } from "../lib/status";
import { Page, Proving, Reveal, Stagger } from "../ui/motion";
import { OnChainDetail } from "../ui/onchain";
import { Button, Card, EmptyState, Input, Skeleton, StatusPill, useToast } from "../ui/primitives";

const LOCAL_INVOICES = "benzo.console.localInvoices";

interface LocalInvoiceRecord {
  invoice: Invoice;
  counterpartyName?: string;
  handle?: string;
  importedAt: string;
}

interface InvoicePacket {
  v?: number;
  counterpartyName?: string;
  handle?: string;
  invoice?: Invoice;
}

function decodeB64url(s: string): string {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function readLocalInvoices(): LocalInvoiceRecord[] {
  try {
    const rows = JSON.parse(localStorage.getItem(LOCAL_INVOICES) || "[]") as LocalInvoiceRecord[];
    return Array.isArray(rows) ? rows.filter((r) => r?.invoice?.id) : [];
  } catch {
    return [];
  }
}

function writeLocalInvoices(rows: LocalInvoiceRecord[]): void {
  localStorage.setItem(LOCAL_INVOICES, JSON.stringify(rows));
}

function packetFromHash(hash: string): LocalInvoiceRecord | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = q.get("import");
  if (!raw) return null;
  try {
    const packet = JSON.parse(decodeB64url(raw)) as InvoicePacket;
    if (!packet.invoice?.id || !packet.invoice.total?.amount || !Array.isArray(packet.invoice.lineItems)) return null;
    return {
      invoice: packet.invoice,
      counterpartyName: packet.counterpartyName,
      handle: packet.handle,
      importedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function Invoices() {
  const toast = useToast();
  const { invoices, counterparties, masked, refresh, loading } = useConsole();
  const [localInvoices, setLocalInvoices] = useState<LocalInvoiceRecord[]>(() => readLocalInvoices());
  const localMeta = (id?: string) => localInvoices.find((r) => r.invoice.id === id);
  const name = (id?: string) => counterparties.find((c) => c.id === id)?.name ?? localMeta(id)?.counterpartyName ?? "Unknown";
  const [busy, setBusy] = useState<string | null>(null);
  // Confirm gate for single-invoice Pay (mirrors the bulk Pay-all confirm).
  const [confirmPay, setConfirmPay] = useState<Invoice | null>(null);

  useEffect(() => {
    const rec = packetFromHash(window.location.hash);
    if (!rec) return;
    setLocalInvoices((rows) => {
      const next = [rec, ...rows.filter((r) => r.invoice.id !== rec.invoice.id)];
      writeLocalInvoices(next);
      return next;
    });
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    toast({ title: "Invoice imported", tone: "success" });
  }, [toast]);

  const allInvoices = useMemo(
    () => [
      ...localInvoices.map((r) => r.invoice),
      ...invoices.filter((i) => !localInvoices.some((r) => r.invoice.id === i.id)),
    ],
    [invoices, localInvoices],
  );
  const open = allInvoices.filter((i) => i.status !== "paid" && i.status !== "cancelled");
  const paid = allInvoices.filter((i) => i.status === "paid");
  const openTotal = open.reduce((s, i) => s + BigInt(i.total.amount), 0n).toString();
  const [payAllOpen, setPayAllOpen] = useState(false);
  const [payingAll, setPayingAll] = useState(false);
  const [weOwe, setWeOwe] = useState("0.30");
  const [theyOwe, setTheyOwe] = useState("0.18");
  const [netting, setNetting] = useState(false);
  const [netRes, setNetRes] = useState<{ onChain: boolean; net: string; wetPay: boolean; ref?: OnChainRef } | null>(null);

  // Cross-entity private netting (Z8) — net mutual invoices with a counterparty
  // and settle only the difference, on-chain (NETTING), neither gross revealed.
  async function netInvoices() {
    setNetting(true);
    setNetRes(null);
    try {
      const r = await api.netInvoices(weOwe, theyOwe);
      setNetRes(r);
      toast({ title: r.onChain ? "Netting proven on-chain" : "Netting computed (demo)", tone: "success" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setNetting(false);
    }
  }

  async function pay(inv: Invoice) {
    setBusy(inv.id);
    try {
      const local = localMeta(inv.id);
      const r = local
        ? {
            invoice: { ...inv, status: "paid" as const },
            payment: await api.createPayment({
              type: "invoice_payment",
              fromAccountId: "acc_op",
              toCounterpartyId: inv.counterpartyId,
              amount: inv.total,
              memo: inv.number,
              toHandle: local.handle,
            }),
          }
        : await api.payInvoice(inv.id);
      const prog = "progress" in r.payment ? r.payment.progress : undefined;
      if (local) {
        if (r.payment.status === "failed") {
          throw new Error("Payment could not settle on-chain. Check that the contractor has a registered payout handle.");
        }
        const settled = r.payment.status === "confirmed" && r.payment.settlement?.onChain === true;
        if (!settled && r.payment.status !== "needs_approval") {
          throw new Error("Payment was created but did not settle on-chain.");
        }
        setLocalInvoices((rows) => {
          const next = rows.map((row) => row.invoice.id === inv.id ? { ...row, invoice: { ...row.invoice, status: settled ? "paid" : "open" } } : row);
          writeLocalInvoices(next);
          return next;
        });
      }
      toast({
        title: prog && !prog.satisfied ? `Queued for approval · needs ${prog.nextRole}` : r.invoice.status === "paid" ? "Invoice paid privately" : "Payment created",
        tone: "success",
      });
      await refresh();
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  // B7 mass-pay: pay every open invoice through the SAME engine (over-threshold
  // ones route to Approvals). Lines resolve independently — some Paid, some
  // Pending review — exactly like Deel's Payments tab.
  async function payAll() {
    setPayingAll(true);
    let okPaid = 0, queued = 0, failed = 0;
    for (const inv of open) {
      try {
        const r = await api.payInvoice(inv.id);
        if (r.payment.progress && !r.payment.progress.satisfied) queued++;
        else okPaid++;
      } catch {
        failed++;
      }
    }
    await refresh();
    setPayingAll(false);
    setPayAllOpen(false);
    toast({
      title: `${okPaid} paid · ${queued} pending review${failed ? ` · ${failed} failed` : ""}`,
      tone: failed ? "danger" : "success",
    });
  }

  return (
    <Page>
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">Invoices to pay</h1>
          <p className="mt-1 text-[13.5px] text-muted">Contractor invoices, paid through the same private, approved settlement as payroll.</p>
        </div>
        {open.length > 1 ? (
          <Button onClick={() => setPayAllOpen(true)} data-testid="pay-all">
            <Wallet size={15} /> Pay all ({open.length}) · {masked ? "••••" : fmtUsd(openTotal)}
          </Button>
        ) : null}
      </div>

      <Card className="mb-5 p-5">
        <div className="flex items-center gap-2 text-[14px] font-semibold">
          <ShieldCheck size={16} className="text-primary" /> Net with a counterparty
        </div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
          When you and a counterparty both owe each other, settle only the difference. The net is proven correct on-chain while neither side's full invoice total is revealed.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Input label="We owe them (USDC)" inputMode="decimal" value={weOwe} onChange={(e) => setWeOwe(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="net-we-owe" />
          </div>
          <div className="w-40">
            <Input label="They owe us (USDC)" inputMode="decimal" value={theyOwe} onChange={(e) => setTheyOwe(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="net-they-owe" />
          </div>
          {netting ? (
            <Proving steps={["Reading both invoice totals", "Proving the net difference", "Verifying the difference on-chain"]} />
          ) : (
            <Button onClick={netInvoices} data-testid="net-invoices">
              <ShieldCheck size={15} /> Prove net
            </Button>
          )}
        </div>
        {netRes ? (
          <Reveal tone="success" className="mt-4 rounded-lg border border-success/30 bg-success/8 px-4 py-3" data-testid="net-result">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1d7a52]">
              <ShieldCheck size={14} /> Settle {fmtUsd(netRes.net)} · {netRes.wetPay ? "you pay them" : "they pay you"}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {netRes.onChain ? "The network verified the net. Neither full invoice total was disclosed." : "Demo proof (not live)."}
            </div>
            {netRes.ref ? <div className="mt-3"><OnChainDetail refData={netRes.ref} /></div> : null}
          </Reveal>
        ) : null}
      </Card>

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex items-center gap-4 p-5">
              <Skeleton className="h-11 w-11 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-6 w-20" />
            </Card>
          ))}
        </div>
      ) : open.length === 0 ? (
        <EmptyState title="Inbox zero" hint="No invoices waiting to be paid." />
      ) : (
        <Stagger className="space-y-4">
          {open.map((inv, i) => (
            <Stagger.Item key={inv.id} index={i}>
              <Card className="flex items-center gap-4 p-5" data-testid={localMeta(inv.id) ? "imported-invoice-row" : undefined}>
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FileText size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold">{inv.number} · {name(inv.counterpartyId)}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-muted">
                    {inv.lineItems[0]?.description ?? "Invoice"}{inv.dueDate ? ` · due ${formatDate(inv.dueDate)}` : ""}
                    {statusMeta(inv.status).eta ? ` · ${statusMeta(inv.status).eta}` : ""}
                  </div>
                </div>
                <div className="font-display tnum flex-none text-lg font-semibold text-fg">{masked ? "••••" : fmtUsd(inv.total.amount)}</div>
                <span title={statusMeta(inv.status).tooltip}><StatusPill status={inv.status} /></span>
                <Button loading={busy === inv.id} onClick={() => setConfirmPay(inv)} data-testid="pay-invoice">
                  <Send size={15} /> Pay
                </Button>
              </Card>
            </Stagger.Item>
          ))}
        </Stagger>
      )}

      {paid.length > 0 ? (
        <>
          <div className="mb-2 mt-7 text-[12px] font-bold uppercase tracking-[0.05em] text-muted">Paid</div>
          <Card className="divide-y divide-border p-0">
            {paid.slice(0, 8).map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-5 py-3 text-[13.5px]">
                <span className="flex-1 truncate">{inv.number} · {name(inv.counterpartyId)}</span>
                <StatusPill status={inv.status} />
                <span className="font-display tnum w-24 text-right font-semibold text-fg">{masked ? "••••" : fmtUsd(inv.total.amount)}</span>
              </div>
            ))}
          </Card>
        </>
      ) : null}

      {payAllOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6 backdrop-blur-sm" onClick={() => !payingAll && setPayAllOpen(false)} data-testid="pay-all-sheet">
          <Card className="w-full max-w-md p-6" >
            <div onClick={(e) => e.stopPropagation()}>
              <h2 className="font-display text-xl">Pay everyone privately</h2>
              <p className="mt-1 text-sm text-muted">{open.length} invoices through the same maker-checker + confidential settlement. Over-threshold ones route to Approvals.</p>
              <div className="mt-4 space-y-2 rounded-xl bg-canvas p-4 text-[14px]">
                <div className="flex justify-between"><span className="text-muted">Invoices</span><span className="font-semibold">{open.length}</span></div>
                <div className="flex justify-between"><span className="text-muted">Total</span><span className="font-display tnum font-semibold">{masked ? "••••" : fmtUsd(openTotal)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Fee</span><span className="font-semibold text-success">Free</span></div>
                <div className="flex justify-between"><span className="text-muted">Arrives</span><span className="font-semibold">In seconds</span></div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-sm text-muted"><ShieldCheck size={13} className="text-primary" /> Each payment stays private — amounts and recipients never go on-chain in the clear.</div>
              <div className="mt-5 flex gap-2">
                <Button variant="ghost" onClick={() => setPayAllOpen(false)} disabled={payingAll}>Cancel</Button>
                <Button className="flex-1" loading={payingAll} onClick={payAll} data-testid="pay-all-confirm">Pay {open.length} privately</Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {confirmPay ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6 backdrop-blur-sm" onClick={() => busy !== confirmPay.id && setConfirmPay(null)} data-testid="pay-sheet">
          <Card className="w-full max-w-md p-6">
            <div onClick={(e) => e.stopPropagation()}>
              <h2 className="font-display text-xl">Pay this invoice privately</h2>
              <p className="mt-1 text-sm text-muted">Runs through the same maker-checker + confidential settlement. If it's over your approval limit, it routes to Approvals first.</p>
              <div className="mt-4 space-y-2 rounded-xl bg-canvas p-4 text-[14px]">
                <div className="flex justify-between"><span className="text-muted">Invoice</span><span className="font-semibold">{confirmPay.number}</span></div>
                <div className="flex justify-between"><span className="text-muted">To</span><span className="font-semibold">{name(confirmPay.counterpartyId)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Total</span><span className="font-display tnum font-semibold">{masked ? "••••" : fmtUsd(confirmPay.total.amount)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Fee</span><span className="font-semibold text-success">Free</span></div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-sm text-muted"><ShieldCheck size={13} className="text-primary" /> The amount and recipient never go on-chain in the clear.</div>
              <div className="mt-5 flex gap-2">
                <Button variant="ghost" onClick={() => setConfirmPay(null)} disabled={busy === confirmPay.id}>Cancel</Button>
                <Button
                  className="flex-1"
                  loading={busy === confirmPay.id}
                  onClick={() => {
                    const inv = confirmPay;
                    setConfirmPay(null);
                    void pay(inv);
                  }}
                  data-testid="pay-confirm"
                >
                  <Send size={15} /> Pay {masked ? "" : fmtUsd(confirmPay.total.amount)} privately
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </Page>
  );
}
