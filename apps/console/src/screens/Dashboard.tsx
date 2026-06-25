/**
 * Dashboard / Overview — the treasury metric (Provable chip + animated sparkline),
 * a "pending your approval" card, and a recent-activity table with amounts masked
 * by default (private by design). Everything settles on real testnet.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Building2, Check, RefreshCw, ShieldCheck, UserPlus, Users, Wallet, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useReducedMotion } from "framer-motion";
import { useConsole } from "../lib/store";
import { fmtUsd, formatDate } from "../lib/format";
import { NETWORK_LABEL } from "../lib/network";
import { Page, Stagger } from "../ui/motion";
import { Button, Card, Pill, ShieldedBadge, StatusPill, Skeleton } from "../ui/primitives";

/** Count a dollar figure up to its target on load (ease-out-cubic; skipped under reduced-motion). */
function useCountUp(target: number, durationMs = 1000): number {
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (reduce || target <= 0) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, durationMs, reduce]);
  return value;
}

/**
 * First-run checklist — the bridge from onboarding to first value. Onboarding sets
 * up the org + treasury keys but the workspace is one un-met prerequisite away from
 * a first payout: it needs funds and a distinct approver (maker-checker blocks the
 * first payout otherwise). Rather than letting the user discover that via an error,
 * we surface a guided checklist from REAL store state — each item flips to
 * done on its own when the underlying condition is met. It auto-hides once all three
 * are complete, and the user can dismiss it (persisted) at any time.
 */
function FirstRunChecklist() {
  const nav = useNavigate();
  const { treasury, members, payrolls, loading } = useConsole();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("benzo.console.firstrun.dismissed") === "1");

  // Seed each item from live state — honest, not a stored "seen" flag.
  const funded = Number(treasury?.totalHidden.amount ?? "0") > 0;
  // Maker-checker needs a proposer ≠ approver, so "invited an approver" means there's
  // someone other than just the owner who can approve a payout: more than one member,
  // at least one of whom holds an approve-capable role.
  const canApprove = (r: string) => r === "approver" || r === "admin" || r === "owner";
  const hasApprover = members.length > 1 && members.some((m) => m.status !== "suspended" && canApprove(m.role));
  const ranPayroll = payrolls.length > 0;

  const items = [
    { key: "fund", done: funded, icon: Wallet, title: "Fund your treasury", hint: "Add USDC so you can run your first payout.", to: "/treasury", cta: "Fund treasury" },
    { key: "approver", done: hasApprover, icon: UserPlus, title: "Invite an approver", hint: "Maker-checker needs a proposer ≠ approver before any payout.", to: "/invites", cta: "Invite" },
    { key: "payroll", done: ranPayroll, icon: Users, title: "Run your first payroll", hint: "Pay your contractors privately — amounts stay confidential.", to: "/payroll", cta: "Start payroll" },
  ] as const;

  const completed = items.filter((i) => i.done).length;
  // Hide while the first load is in flight (avoid a flash of all-incomplete), once
  // everything's done, or once the user dismisses it.
  if (dismissed || loading || completed === items.length) return null;

  function dismiss() {
    localStorage.setItem("benzo.console.firstrun.dismissed", "1");
    setDismissed(true);
  }

  return (
    <Card className="mb-5 p-5" data-testid="firstrun-checklist">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-display text-[15px]">Finish setting up</div>
          <div className="mt-0.5 text-[12.5px] text-muted">{completed} of {items.length} done · a couple of steps to your first private payout</div>
        </div>
        <button onClick={dismiss} aria-label="Dismiss setup checklist" data-testid="firstrun-dismiss" className="flex-none rounded-md p-1 text-[#a3a7ac] outline-none transition hover:bg-[#f4f3ef] hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40">
          <X size={16} />
        </button>
      </div>
      <div className="mt-4 space-y-2">
        {items.map((it) => (
          <div key={it.key} className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-2.5">
            <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full ${it.done ? "bg-success/15 text-[#1d7a52]" : "bg-primary/10 text-primary"}`}>
              {it.done ? <Check size={15} /> : <it.icon size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-[13.5px] font-semibold ${it.done ? "text-muted line-through" : "text-ink"}`}>{it.title}</div>
              {!it.done ? <div className="text-[12px] text-muted">{it.hint}</div> : null}
            </div>
            {it.done ? (
              <Pill tone="success"><Check size={11} /> Done</Pill>
            ) : (
              <Button size="sm" variant="outline" className="flex-none" onClick={() => nav(it.to)} data-testid={`firstrun-${it.key}`}>{it.cta}</Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Dashboard() {
  const nav = useNavigate();
  const { dashboard, treasury, payments, masked, loading, error, refresh } = useConsole();
  const pending = payments.filter((p) => p.status === "needs_approval");
  // A payment row is unverified when its backing payment never settled on-chain.
  const unverifiedActivityIds = new Set(
    payments
      .filter((p) => p.settlement?.onChain === false)
      .map((p) => p.id),
  );
  const targetDollars = Number(treasury?.totalHidden.amount ?? dashboard?.totalPosition.amount ?? "0") / 1e7;
  const animatedTotal = useCountUp(targetDollars);

  return (
    <Page>
      <div className="mb-5">
        <h1 className="font-display text-2xl">Overview</h1>
        <p className="mt-1 text-[13.5px] text-muted">Everything settles on real Stellar {NETWORK_LABEL} · amounts are private by default</p>
      </div>

      <FirstRunChecklist />

      {error && !loading ? (
        <Card className="mb-5 flex items-center justify-between gap-4 border-danger/30 bg-danger/8 p-4" data-testid="dashboard-error">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-danger">Couldn't load your console</div>
            <div className="mt-0.5 truncate text-[12.5px] text-muted">{error}</div>
          </div>
          <Button variant="outline" className="flex-none" onClick={() => void refresh()} data-testid="dashboard-retry">
            <RefreshCw size={14} /> Retry
          </Button>
        </Card>
      ) : null}

      <Stagger className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Stagger.Item index={0} className="h-full">
          <Card className="flex h-full flex-col p-5">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
              Treasury balance
              <Pill tone="shielded">
                <ShieldCheck size={12} /> Provable on demand
              </Pill>
            </div>
            {loading ? (
              <Skeleton className="mt-2 h-10 w-48" />
            ) : (
              <div className="font-display tnum mt-2 text-[40px] leading-none" data-testid="treasury-total">
                {fmtUsd(String(Math.round(animatedTotal * 1e7)))}
              </div>
            )}
            <div className="mt-2 text-[12.5px] text-muted">Across all accounts · private by default</div>
          </Card>
        </Stagger.Item>

        <Stagger.Item index={1} className="h-full">
          <Card className="flex h-full flex-col p-5">
            <div className="text-[12.5px] font-medium text-muted">Pending your approval</div>
            <div className="font-display tnum mt-1 text-[34px] leading-none" data-testid="pending-count">{pending.length}</div>
            <div className="mt-2 flex-1">
              {pending.slice(0, 2).map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 border-b border-border py-2.5 text-[13.5px] last:border-0">
                  {p.type === "payroll_payout" ? <Users size={15} className="text-[#8a9099]" /> : <Building2 size={15} className="text-[#8a9099]" />}
                  <span className="flex-1 truncate">{p.memo ?? "Payment"}</span>
                  <span className="font-display tnum font-semibold text-fg">{masked || p.privacy.amountHidden ? "••••" : fmtUsd(p.amount.amount)}</span>
                </div>
              ))}
              {pending.length === 0 ? <div className="py-4 text-sm text-muted">Nothing waiting on you.</div> : null}
            </div>
            <Button className="mt-3 self-start" onClick={() => nav("/approvals")} data-testid="review-approvals">
              Review approvals <ArrowRight size={15} />
            </Button>
          </Card>
        </Stagger.Item>
      </Stagger>

      <Stagger className="mt-8">
        <Stagger.Item index={2}>
          <Card className="overflow-hidden p-0">
            <div className="border-b border-border px-5 py-3.5 text-[13px] font-semibold">Recent activity</div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    {["Payee", "Type", "Status", "Amount"].map((h, i) => (
                      <th key={h} className={`bg-bg px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.05em] text-[#a3a7ac] ${i === 3 ? "text-right" : "text-left"}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    [0, 1, 2].map((i) => (
                      <tr key={i}>
                        <td className="border-t border-border px-5 py-3" colSpan={4}>
                          <Skeleton className="h-4 w-full" />
                        </td>
                      </tr>
                    ))
                  ) : (dashboard?.recentActivity ?? []).length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-muted" colSpan={4}>
                        No activity yet.
                      </td>
                    </tr>
                  ) : (
                    dashboard?.recentActivity.map((a) => {
                      const isPrivate = a.amountLabel === "Private" || masked;
                      return (
                        <tr key={a.id} className="transition hover:bg-[#f4f3ef]/60" data-testid="activity-row">
                          <td className="border-t border-border px-5 py-3 text-[#2c3744]">{a.title}</td>
                          <td className="border-t border-border px-5 py-3 capitalize text-muted">{a.kind}</td>
                          <td className="border-t border-border px-5 py-3">
                            <span className="inline-flex items-center gap-1.5">
                              <StatusPill status={a.status} />
                              {unverifiedActivityIds.has(a.id) ? <Pill tone="warning">Unverified</Pill> : null}
                            </span>
                          </td>
                          <td className="border-t border-border px-5 py-3 text-right font-display tnum">
                            {isPrivate ? <span className="mask">••••••</span> : <span className="inline-flex items-center gap-1.5 font-semibold text-fg">{a.amountLabel} <ShieldedBadge /></span>}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </Stagger.Item>
      </Stagger>
    </Page>
  );
}
