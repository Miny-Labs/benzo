/**
 * Work (P0-B3) - the contractor's mini-portal inside the consumer wallet. After
 * accepting a business invite they land here to BILL the org: submit an invoice
 * that drops into the company's AP inbox, where it's paid through the same
 * maker-checker + confidential settlement as payroll. Their wallet identity stays
 * theirs; the org only ever sees an invoice tied to their @handle.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Briefcase, Check, ChevronDown, FileText, Send, Building2 } from "lucide-react";
import { orgApi, type OrgInvoice } from "../lib/orgApi";
import { friendlyError } from "../lib/errors";
import { fmtUsd } from "../lib/format";
import { useWallet } from "../lib/store";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { AmountField, Button, Card, Input, EmptyState, Skeleton, useToast } from "../ui/primitives";

const MAX_INVOICE = 1_000_000; // sanity cap so a fat-fingered amount can't post

function consoleOrigin(): string {
  const configured = (import.meta as { env?: Record<string, string> }).env?.VITE_CONSOLE_ORIGIN;
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window === "undefined") return "http://localhost:5174";
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" ? "http://localhost:5174" : "https://console.benzo.space";
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function invoiceHandoffLink(inv: OrgInvoice, opts: { org: string; counterpartyName?: string; handle?: string }): string {
  const packet = {
    v: 1,
    orgName: opts.org,
    counterpartyName: opts.counterpartyName,
    handle: opts.handle,
    invoice: inv,
    issuedAt: new Date().toISOString(),
  };
  return `${consoleOrigin()}/invoices#import=${b64url(JSON.stringify(packet))}`;
}

import { getLocalAccountSummary } from "../lib/localWallet";

export function Work() {
  const [params] = useSearchParams();
  const toast = useToast();
  const { session } = useWallet();
  const cp = params.get("cp") ?? "";
  const org = params.get("org") ?? "the company";
  const inviteToken = params.get("token") ?? undefined;
  const missingInvite = !cp || !inviteToken;
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<OrgInvoice[] | null>(null);
  const [loadErr, setLoadErr] = useState<null | "invite" | "network">(null);
  const [open, setOpen] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);

  const n = Number(amount);
  const amountOk = Number.isFinite(n) && n > 0 && n <= MAX_INVOICE;

  const load = () => {
    if (missingInvite) {
      setMine([]);
      setLoadErr(null);
      return Promise.resolve();
    }
    return orgApi
      .invoices(inviteToken)
      .then((all) => { setMine(all.filter((i) => i.counterpartyId === cp)); setLoadErr(null); })
      // A down backend shouldn't masquerade as "No invoices yet" - flag it so we can
      // offer a retry instead of a deceptive empty state (only when we have nothing yet).
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        const kind = /invite not found|expired/i.test(message) ? "invite" : "network";
        setLoadErr((had) => (mine == null ? kind : had));
      });
  };
  useEffect(() => {
    if (missingInvite) {
      setMine([]);
      setLoadErr(null);
      return undefined;
    }
    if (loadErr) return undefined;
    void load();
    const t = setInterval(load, 5000); // poll so "Paid" appears after the employer pays
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cp, inviteToken, loadErr]);

  async function submit() {
    if (!amountOk || !desc.trim() || !cp) return;
    setBusy(true);
    try {
      const inv = await orgApi.submitInvoice(cp, amount, desc.trim(), inviteToken);
      const summary = getLocalAccountSummary();
      const contractorHandle = summary?.address || "";
      setHandoff(invoiceHandoffLink(inv, { org, counterpartyName: session?.profile.name ?? "Contractor", handle: contractorHandle }));
      setAmount("");
      setDesc("");
      await load();
      toast({ title: "Invoice sent", tone: "success" });
    } catch (e) {
      toast({ title: friendlyError(e, "Couldn't send the invoice. Please try again."), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Work" />
      <div className="px-5 pt-2">
        <div className="flex items-center gap-3 rounded-2xl bg-accent/[0.06] p-4">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent/15 text-accent">
            <Briefcase size={18} />
          </div>
          <div className="text-[13px] text-ink">
            You're billing <b>{org}</b>. Invoices you send are paid privately to your wallet.
          </div>
        </div>

        {missingInvite ? (
          <Card className="mt-5 flex flex-col items-center gap-2 px-6 py-8 text-center" data-testid="work-missing-invite">
            <div className="text-sm font-semibold text-ink">Open this from a contractor invite</div>
            <div className="max-w-[270px] text-[13px] text-muted">Ask the company to send a fresh work link, then open it from this wallet.</div>
          </Card>
        ) : (
          <Card className="mt-5 p-5">
            <div className="mb-1 text-[13px] font-semibold text-ink">New invoice</div>
            <AmountField value={amount} onChange={setAmount} />
            <Input className="mt-3" label="What's it for?" placeholder="Services for this period" value={desc} onChange={(e) => setDesc(e.target.value)} data-testid="work-desc" />
            <Button full size="lg" className="mt-4" loading={busy} disabled={!amountOk || !desc.trim() || !cp} onClick={submit} data-testid="work-submit">
              <Send size={16} /> Send invoice
            </Button>
          </Card>
        )}

        {handoff ? (
          <Card className="mt-4 p-4" data-testid="work-invoice-handoff">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Building2 size={15} className="text-accent" /> Ready for AP
            </div>
            <a
              href={handoff}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-card px-5 py-3 text-[15px] font-semibold text-ink shadow-[0_6px_18px_rgba(25,40,55,0.05)] outline-none transition hover:shadow-[0_8px_22px_rgba(25,40,55,0.09)] focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="work-invoice-open-console"
            >
              Open in company console <ChevronDown size={16} className="-rotate-90" />
            </a>
          </Card>
        ) : null}

        <div className="mt-6">
          <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Your invoices</div>
          {mine === null && loadErr ? (
            <Card className="flex flex-col items-center gap-2 px-6 py-8 text-center">
              <div className="text-sm font-semibold text-ink">
                {loadErr === "invite" ? "This work link is invalid or expired" : "Couldn't load your invoices"}
              </div>
              <div className="max-w-[250px] text-[13px] text-muted">
                {loadErr === "invite" ? "Ask the company to send a fresh contractor invite." : "Check your connection and try again."}
              </div>
              {loadErr === "network" ? (
                <Button size="sm" variant="secondary" className="mt-1" onClick={() => void load()} data-testid="work-retry">Retry</Button>
              ) : null}
            </Card>
          ) : mine === null ? (
            <Card className="divide-y divide-hair/60 p-0">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-3.5 flex-1 rounded" />
                  <Skeleton className="h-4 w-16 rounded" />
                  <Skeleton className="h-5 w-12 rounded-full" />
                </div>
              ))}
            </Card>
          ) : mine.length === 0 ? (
            <EmptyState title="No invoices yet" hint="Send your first invoice above." />
          ) : (
            <Card className="divide-y divide-hair/60 p-0">
              {mine.map((inv) => (
                <div key={inv.id} data-testid="work-invoice">
                  <button
                    onClick={() => setOpen((o) => (o === inv.id ? null : inv.id))}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left text-[13.5px] transition outline-none hover:bg-canvas/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                    data-testid="work-invoice-row"
                  >
                    <FileText size={16} className="flex-none text-muted" />
                    <span className="min-w-0 flex-1 truncate">{inv.lineItems[0]?.description ?? inv.number}</span>
                    <span className="font-display tnum flex-none">{fmtUsd(inv.total.amount)}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${inv.status === "paid" ? "bg-pos/12 text-pos" : "bg-ink/[0.05] text-muted"}`}>
                      {inv.status === "paid" ? <Check size={12} /> : null}
                      {inv.status === "paid" ? "Paid" : "Sent"}
                    </span>
                    <ChevronDown size={15} className={`flex-none text-muted transition-transform ${open === inv.id ? "rotate-180" : ""}`} />
                  </button>
                  <AnimatePresence initial={false}>
                    {open === inv.id ? (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <PaymentTracker paid={inv.status === "paid"} />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </Screen>
  );
}

/** Deel-style payment tracker for a contractor invoice (submitted → review → paid). */
function PaymentTracker({ paid }: { paid: boolean }) {
  const steps = [
    { label: "Invoice submitted", hint: undefined as string | undefined, done: true, active: false },
    { label: "Under review", hint: paid ? undefined : "The company is approving it", done: paid, active: !paid },
    { label: paid ? "Paid privately to your wallet" : "Payment", hint: paid ? undefined : "Arrives in seconds once approved", done: paid, active: false },
  ];
  return (
    <div className="px-5 pb-4 pt-1" data-testid="work-tracker">
      <div className="rounded-2xl bg-canvas/60 p-4">
        {steps.map((s, i) => (
          <div key={s.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-full ${s.done ? "bg-pos text-white" : s.active ? "bg-accent text-white" : "bg-hair text-muted"}`}>
                {s.done ? <Check size={11} /> : s.active ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
              </span>
              {i < steps.length - 1 ? <span className={`my-1 w-0.5 flex-1 ${s.done ? "bg-pos/40" : "bg-hair"}`} style={{ minHeight: 14 }} /> : null}
            </div>
            <div className="pb-2.5">
              <div className={`text-[13px] font-semibold ${s.done || s.active ? "text-ink" : "text-muted"}`}>{s.label}</div>
              {s.hint ? <div className="text-[11.5px] text-muted">{s.hint}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
