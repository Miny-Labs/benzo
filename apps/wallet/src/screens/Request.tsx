import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Check, Copy, Inbox, Link2, X } from "lucide-react";
import { copyTextToClipboard } from "../lib/clipboard";
import { friendlyError } from "../lib/errors"; // friendlyError is imported from format/errors? Wait, in the original it was from "../lib/errors". Let's check imports.
import { fmtUsd } from "../lib/format";
import { addRequest, listRequests, cancelRequest, markReminded, remindedToday, updateRequestStatus, type MoneyRequest } from "../lib/requests";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { AmountField, Button, Card, EmptyState, Input, Sheet, useToast } from "../ui/primitives";
import { PrivateChip } from "../ui/privacy";
import { useWallet } from "../lib/store";
import { getLocalAccount } from "../lib/localWallet";
import { encodeRecipient } from "../lib/recipient";
import { encodeBenzoLink } from "@benzo/links";

export function Request() {
  const toast = useToast();
  const { history } = useWallet();
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, bump] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState<MoneyRequest | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const requests = listRequests();
  const pendingRequestIds = useMemo(
    () => requests
      .filter((r) => r.status === "pending" || r.status === "partially_paid")
      .map((r) => r.id)
      .join("|"),
    [requests],
  );

  // Reconcile pending requests locally against incoming transaction history
  useEffect(() => {
    if (!pendingRequestIds) return;
    const pendingIds = pendingRequestIds.split("|").filter(Boolean);
    let changed = false;
    for (const reqId of pendingIds) {
      const req = requests.find((r) => r.id === reqId);
      if (!req) continue;
      const found = history.find((h) => {
        if (h.direction !== "in") return false;
        const memoMatch = req.memo && h.note.toLowerCase().includes(req.memo.toLowerCase());
        const idMatch = h.note.includes(req.id);
        return memoMatch || idMatch;
      });
      if (found) {
        updateRequestStatus(reqId, "paid", found.amount);
        changed = true;
      }
    }
    if (changed) {
      bump((n) => n + 1);
    }
  }, [history, pendingRequestIds, requests]);

  async function create() {
    setBusy(true);
    try {
      const account = getLocalAccount();
      if (!account) throw new Error("Wallet is locked.");
      const to = encodeRecipient({
        spendPub: account.spendPub,
        viewPub: account.viewPub,
        mvkScalar: account.mvkScalar,
      });
      const reqId = Math.random().toString(36).substring(2, 10);
      const stroops = amount ? BigInt(Math.round(Number(amount) * 1e7)).toString() : undefined;
      const requestLink = encodeBenzoLink({
        type: "request",
        to,
        amount: stroops,
        memo: memo || undefined,
        id: reqId,
        app: "consumer",
      }, "web");
      addRequest({ id: reqId, link: requestLink, amount: stroops, memo: memo || undefined });
      setLink(requestLink);
      bump((n) => n + 1);
    } catch (e) {
      toast({ title: friendlyError(e, "Couldn't create the request. Please try again."), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    const ok = await copyTextToClipboard(text);
    setCopied(ok);
    toast({ title: ok ? "Link copied" : "Copy blocked. Select the link.", tone: ok ? "success" : "danger" });
    setTimeout(() => setCopied(false), 1500);
  }

  function remind(r: MoneyRequest) {
    void copy(r.link);
    markReminded(r.id);
    bump((n) => n + 1);
  }

  async function doCancel(id: string) {
    setCancelling(true);
    try {
      cancelRequest(id);
      setConfirmCancel(null);
      bump((n) => n + 1);
      toast({ title: "Request cancelled", tone: "muted" });
    } catch (e) {
      toast({ title: friendlyError(e, "Couldn't cancel the request. The link is still active."), tone: "danger" });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Request" />
      <div className="px-5 pt-2">
        <div className="mt-4">
          <AmountField value={amount} onChange={setAmount} autoFocus />
          <div className="text-center text-[13px] text-muted">{amount ? `Request ${fmtUsd(BigInt(Math.round(Number(amount) * 1e7) || 0).toString())}` : "Any amount"}</div>
        </div>
        <Input className="mt-5" label="Note (optional)" placeholder="What's it for?" value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="request-memo" />

        <div className="mt-5 flex justify-center">
          <PrivateChip label="Only you see who pays" />
        </div>

        <AnimatePresence mode="wait">
          {!link ? (
            <motion.div key="cta" exit={{ opacity: 0 }}>
              <Button full size="lg" className="mt-4" loading={busy} onClick={create} data-testid="request-create">
                <Link2 size={16} /> Create request link
              </Button>
            </motion.div>
          ) : (
            <motion.div key="link" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
              <div className="rounded-2xl border border-hair bg-card p-4" data-testid="request-link">
                <div className="text-[12px] font-bold uppercase tracking-[0.05em] text-muted">Share to get paid</div>
                <div className="mt-1 break-all font-mono text-[12.5px] text-ink">{link}</div>
                <Button full className="mt-3" variant="secondary" onClick={() => void copy(link)}>
                  {copied ? <Check size={16} className="text-pos" /> : <Copy size={16} />} {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <Button full variant="secondary" className="mt-3" onClick={() => { setLink(null); setAmount(""); setMemo(""); }}>New request</Button>
            </motion.div>
          )}
        </AnimatePresence>

        {requests.length === 0 ? (
          <EmptyState
            icon={<Inbox size={26} />}
            title="No requests yet"
            hint="Create a link above to ask someone for money. Your requests show up here."
          />
        ) : (
          <div className="mt-7" data-testid="requests-list">
            <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.05em] text-muted">Your requests</div>
            <div className="space-y-3">
              {requests.map((r) => (
                <Card key={r.id} className="flex items-center gap-3 p-3.5" data-testid="request-row">
                  <div className="min-w-0 flex-1">
                    <div className="tnum text-sm font-semibold">{r.amount ? fmtUsd(r.amount) : "Any amount"}{r.to ? ` · ${r.to}` : ""}</div>
                    <div className="truncate text-xs text-muted">{r.memo || "Payment request"}</div>
                  </div>
                  <ReqStatus status={r.status} />
                  {r.status === "pending" ? (
                    <>
                      <button onClick={() => remind(r)} disabled={remindedToday(r)} aria-label="Remind" data-testid="request-remind" className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:text-accent disabled:opacity-40">
                        <Bell size={16} />
                      </button>
                      <button onClick={() => setConfirmCancel(r)} aria-label="Cancel" data-testid="request-cancel" className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                        <X size={16} />
                      </button>
                    </>
                  ) : null}
                </Card>
              ))}
            </div>
          </div>
        )}
        <div className="h-6" />
      </div>

      <Sheet open={!!confirmCancel} onClose={() => setConfirmCancel(null)} title="Cancel this request?">
        {confirmCancel ? (
          <div data-testid="request-cancel-confirm">
            <p className="text-[14px] text-muted">
              The link for {confirmCancel.amount ? <b className="text-ink">{fmtUsd(confirmCancel.amount)}</b> : "this request"} stops working and it's removed from your list. This can't be undone.
            </p>
            <div className="mt-5 flex gap-3">
              <Button full variant="secondary" disabled={cancelling} onClick={() => setConfirmCancel(null)}>Keep it</Button>
              <Button full variant="danger" loading={cancelling} onClick={() => void doCancel(confirmCancel.id)} data-testid="request-cancel-confirm-btn">Cancel request</Button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </Screen>
  );
}

function ReqStatus({ status }: { status: MoneyRequest["status"] }) {
  const map: Record<MoneyRequest["status"], { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "bg-amber/12 text-[#9a6b12]" },
    partially_paid: { label: "Part paid", cls: "bg-accent/10 text-accent" },
    paid: { label: "Paid", cls: "bg-pos/12 text-pos" },
    declined: { label: "Declined", cls: "bg-ink/[0.06] text-muted" },
    expired: { label: "Expired", cls: "bg-ink/[0.06] text-muted" },
    cancelled: { label: "Cancelled", cls: "bg-ink/[0.06] text-muted" },
  };
  const m = map[status];
  return <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${m.cls}`}>{m.label}</span>;
}
