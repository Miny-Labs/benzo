import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, Gift, RotateCcw, Share2 } from "lucide-react";
import { type InviteResult, type InviteSummary } from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import { friendlyError } from "../lib/errors";
import { useWallet } from "../lib/store";
import { fmtUsd } from "../lib/format";
import { inviteAmountToStroops, validateFundedInviteAmount } from "../lib/inviteValidation";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { AmountField, Button, Card, Input, Skeleton, useToast } from "../ui/primitives";
import { addLocalInvite, listLocalInvites, updateLocalInviteStatus } from "../lib/invites";
import { createInviteClientSide, refundInviteClientSide } from "../lib/benzoClient";

function daysLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt * 1000 - Date.now()) / 86_400_000));
}

export function InviteExternal() {
  const [params] = useSearchParams();
  const toast = useToast();
  const { balance, refresh } = useWallet();
  const [amount, setAmount] = useState(params.get("amount") ?? "");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<InviteResult | null>(null);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const recipient = params.get("to") ?? "";

  const load = () => {
    setInvites(listLocalInvites());
    return Promise.resolve();
  };
  useEffect(() => {
    void load();
  }, []);

  const amountState = validateFundedInviteAmount(amount, balance?.stroops);
  const canCreate = amountState.amountOk && !amountState.insufficient;

  async function create() {
    if (!canCreate) {
      if (amountState.message) toast({ title: amountState.message, tone: "danger" });
      return;
    }
    setCreating(true);
    try {
      const stroops = inviteAmountToStroops(amount);
      const res = await createInviteClientSide(stroops);
      if (!res) throw new Error("Could not create claim link.");
      addLocalInvite({
        localId: res.claimSecretHex,
        amount: stroops,
        note: note || undefined,
        claimSecretHex: res.claimSecretHex,
        link: res.link,
      });
      setCreated({
        link: res.link,
        amount: stroops,
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        localId: res.claimSecretHex,
        claimAccountPub: "",
        onChain: !!res.txHash,
      });
      await load();
      void refresh();
    } catch (e) {
      toast({ title: friendlyError(e, "Couldn't create the link. Please try again."), tone: "danger" });
    } finally {
      setCreating(false);
    }
  }

  async function refund(localId: string) {
    try {
      await refundInviteClientSide(localId);
      updateLocalInviteStatus(localId, "refunded");
      toast({ title: "Refunded to your wallet", tone: "success" });
      await load();
      void refresh();
    } catch (e) {
      toast({ title: friendlyError(e, "Couldn't refund right now. Please try again."), tone: "danger" });
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Invite & send" />
      <div className="px-5 pt-2">
        {!created ? (
          <>
            <div className="flex items-center gap-3 rounded-2xl bg-accent/[0.06] p-4">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent/15 text-accent">
                <Gift size={18} />
              </div>
              <p className="text-[13px] text-ink">
                Send money to anyone, even if they're not on Benzo yet{recipient ? ` (${recipient})` : ""}. They get a link to claim it.
              </p>
            </div>

            <div className="mt-6">
              <AmountField value={amount} onChange={setAmount} autoFocus />
              <div className="text-center text-[13px] text-muted">they'll claim this amount</div>
              {amountState.message ? <div className="mt-2 text-center text-[12px] font-medium text-danger" data-testid="invite-amount-error">{amountState.message}</div> : null}
            </div>
            <Input className="mt-5" label="Note (optional)" placeholder="What's it for?" value={note} onChange={(e) => setNote(e.target.value)} data-testid="invite-note" />

            <Button full size="lg" className="mt-6" loading={creating} disabled={!canCreate} onClick={create} data-testid="invite-create">
              {amountState.amountOk ? `Create link · ${fmtUsd(inviteAmountToStroops(amount))}` : "Create link"}
            </Button>
          </>
        ) : (
          <ShareLink result={created} onAnother={() => { setCreated(null); setAmount(""); setNote(""); }} />
        )}

        {invites === null ? (
          <div className="mt-8">
            <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Pending & past invites</div>
            <Card className="divide-y divide-hair/60 p-0">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                  <Skeleton className="h-4 w-20 rounded" />
                  <Skeleton className="h-3.5 flex-1 rounded" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
              ))}
            </Card>
          </div>
        ) : invites.length > 0 ? (
          <div className="mt-8">
            <div className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Pending & past invites</div>
            <Card className="divide-y divide-hair/60 p-0">
              {invites.slice(0, 8).map((inv) => (
                <div key={inv.localId} className="flex items-center gap-3 px-4 py-3 text-[13.5px]" data-testid="invite-row">
                  <span className="font-display tnum w-20 flex-none text-ink">{fmtUsd(inv.amount)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{inv.note ?? "Invite"}</span>
                  <StatusPill status={inv.status} />
                  {inv.status === "pending" || inv.status === "expired" ? (
                    <button onClick={() => refund(inv.localId)} className="inline-flex items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11px] font-semibold text-ink outline-none hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="invite-refund">
                      <RotateCcw size={12} /> Refund
                    </button>
                  ) : null}
                </div>
              ))}
            </Card>
          </div>
        ) : null}
      </div>
    </Screen>
  );
}

function ShareLink({ result, onAnother }: { result: InviteResult; onAnother: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyTextToClipboard(result.link);
    setCopied(ok);
    toast({ title: ok ? "Link copied" : "Copy blocked. Select the link above.", tone: ok ? "success" : "danger" });
    setTimeout(() => setCopied(false), 1500);
  }
  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: "Money for you on Benzo", text: "Claim the money I sent you:", url: result.link });
      else void copy();
    } catch {
      /* user dismissed */
    }
  }

  return (
    <div className="text-center">
      <div className="mx-auto mt-3 flex h-16 w-16 items-center justify-center rounded-full bg-pos/12 text-pos">
        <Check size={30} />
      </div>
      <div className="font-display mt-3 text-2xl">Link ready</div>
      <div className="mt-1 text-[14px] text-muted">{fmtUsd(result.amount)} is waiting to be claimed</div>

      <div className="mt-5 break-all rounded-2xl bg-card p-4 text-left text-[12px] text-ink shadow-[var(--shadow-card)]" data-testid="invite-link">
        {result.link}
      </div>
      <div className="mt-3 flex gap-3">
        <Button variant="secondary" full onClick={copy} data-testid="invite-copy">
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy"}
        </Button>
        <Button full onClick={share}>
          <Share2 size={16} /> Share
        </Button>
      </div>

      <p className="mt-4 text-[12.5px] text-muted">
        Unclaimed funds return to you in {daysLeft(result.expiresAt)} days. {result.onChain ? "" : "This link is not funded on-chain."}
      </p>
      <button onClick={onAnother} className="mt-4 rounded text-[13px] font-semibold text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        Send another
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: InviteSummary["status"] }) {
  const map = {
    pending: "bg-accent/10 text-accent",
    claimed: "bg-pos/12 text-pos",
    refunded: "bg-ink/[0.06] text-ink",
    expired: "bg-[#fbf1dd] text-[#9a6b12]",
  }[status];
  return <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${map}`}>{status}</span>;
}
