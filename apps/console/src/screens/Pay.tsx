/**
 * Send & vendor pay - create a confidential payment. Pick a funding account and
 * who you're paying, then review before it goes. Over-threshold payments route to
 * approval; the rest send right away. The payee's payout handle is resolved
 * server-side, so you never re-type it.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ArrowUpRight, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { api } from "../lib/api";
import { useConsole } from "../lib/store";
import { fmtUsd, formatAddress } from "../lib/format";
import { Page } from "../ui/motion";
import { Button, Card, Input, PrivacyDisclosure, Select, useToast } from "../ui/primitives";

function toStroops(human: string): string {
  const [w, f = ""] = human.replace(/[$,]/g, "").trim().split(".");
  return (BigInt(w || "0") * 10_000_000n + BigInt(f.padEnd(7, "0").slice(0, 7) || "0")).toString();
}

export function Pay() {
  const nav = useNavigate();
  const toast = useToast();
  const { accounts, counterparties, dashboard, refresh } = useConsole();
  const live = dashboard?.live ?? false;
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [fromAccountId, setFrom] = useState("");
  const [toCounterpartyId, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; onChain?: boolean; unpayable?: boolean } | null>(null);

  const fromName = accounts.find((a) => a.id === fromAccountId)?.name ?? "";
  const payee = counterparties.find((c) => c.id === toCounterpartyId);
  const valid = !!fromAccountId && !!toCounterpartyId && Number(amount) > 0;

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const po = await api.createPayment({
        type: "shielded_transfer",
        fromAccountId,
        toCounterpartyId,
        amount: { amount: toStroops(amount), assetCode: "USDC" },
        memo: memo || undefined,
      });
      const settledOnChain = po.settlement?.onChain ?? false;
      const unpayable = !settledOnChain && po.status !== "needs_approval";
      setResult({ status: po.status, onChain: settledOnChain, unpayable });
      toast({
        title:
          po.status === "needs_approval"
            ? "Sent for approval"
            : settledOnChain
              ? "Paid privately"
              : unpayable
                ? live ? "Payment did not settle on-chain" : "Live chain connection required"
                : "Payment created",
        tone: po.status === "needs_approval" || settledOnChain ? "success" : "danger",
      });
      await refresh();
    } catch (e) {
      const m = (e as Error).message;
      // surface the useful operational errors; genericize anything that reads technical
      const friendly = /handle|balance|approv|amount|fund/i.test(m) ? m : "Couldn't send this payment. Please try again.";
      toast({ title: friendly, tone: "danger" });
      setStep("form");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <div className="mb-5">
        <h1 className="font-display text-2xl">Send & vendor pay</h1>
        <p className="mt-1 text-[13.5px] text-muted">Pay a vendor or contractor privately. The amount and who you paid stay confidential.</p>
      </div>

      <div className="grid max-w-3xl grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card className="space-y-4 p-5">
          {step === "form" ? (
            <>
              <Select label="Pay from" value={fromAccountId} onChange={(e) => setFrom(e.target.value)} data-testid="pay-from">
                <option value="">Choose an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.assetCode})
                  </option>
                ))}
              </Select>
              <Select label="Pay to" value={toCounterpartyId} onChange={(e) => setTo(e.target.value)} data-testid="pay-to">
                <option value="">Choose who you're paying…</option>
                {counterparties.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Input label="Amount" placeholder="0.00" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="pay-amount" />
              <Input label="Note (optional)" placeholder="PO-4480 components" value={memo} onChange={(e) => setMemo(e.target.value)} />
              <Button className="w-full" disabled={!valid} onClick={() => setStep("confirm")} data-testid="pay-review">
                Review payment
              </Button>
            </>
          ) : (
            <>
              <div className="text-[13px] font-semibold text-ink">Review before sending</div>
              <div className="space-y-2 rounded-xl border border-border p-4 text-[13.5px]">
                <Row k="Pay from" v={fromName} />
                <Row k="Pay to" v={payee?.name ?? "-"} />
                {/* Show the actual on-chain destination material (not just the display
                    name) so the approver verifies WHO the money settles to. */}
                {payee?.paymentAddress?.shielded ? (
                  <Row k="Recipient" v={<span className="font-mono text-[12px]">{formatAddress(payee.paymentAddress.shielded, 6, 6)}</span>} />
                ) : null}
                <Row k="Amount" v={<span className="font-display tnum">{fmtUsd(toStroops(amount))}</span>} />
                {memo ? <Row k="Note" v={memo} /> : null}
                <Row k="Fee" v={<span className="font-semibold text-success">Free</span>} />
                <Row k="Arrives" v="In seconds" />
              </div>
              {!payee?.paymentAddress?.shielded ? (
                <p className="text-[12px] text-[#9a6b12]">
                  This contractor has no payout handle on file yet. The payment may not settle on-chain until they're invited and onboarded.
                </p>
              ) : null}
              <p className="text-[12px] text-muted">The amount and recipient stay private. If it's over your approval limit, it goes to Approvals first.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setStep("form")} disabled={busy}>
                  Back
                </Button>
                <Button className="flex-1" loading={busy} onClick={submit} data-testid="pay-submit">
                  <ArrowUpRight size={16} /> Send {fmtUsd(toStroops(amount))} privately
                </Button>
              </div>
            </>
          )}

          {result ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[13px] ${
                result.unpayable ? "border-danger/30 bg-danger/8 text-[#b4232a]" : "border-success/30 bg-success/8 text-[#1d7a52]"
              }`}
              data-testid="pay-result"
            >
              <span>
                {result.status === "needs_approval"
                  ? "Sent for approval (over your limit)."
                  : result.onChain
                    ? "Paid privately. All done."
                    : result.unpayable
                      ? "This payment did not settle on-chain. Check the recipient handle and treasury balance, then try again."
                      : "Payment created."}
              </span>
              {result.status === "needs_approval" ? (
                <button onClick={() => nav("/approvals")} className="inline-flex flex-none items-center gap-1 font-semibold text-primary hover:underline">
                  Go to Approvals <ArrowRight size={13} />
                </button>
              ) : result.unpayable ? (
                <button onClick={() => nav("/invites")} className="inline-flex flex-none items-center gap-1 font-semibold text-primary hover:underline">
                  Invite <ArrowRight size={13} />
                </button>
              ) : null}
            </motion.div>
          ) : null}
        </Card>

        <div className="space-y-4">
          <PrivacyDisclosure hidden={["Amount", "Who you paid"]} proven={["You're an approved sender", "Funds verified clean"]} />
          <Card className="p-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-primary">
              <ShieldCheck size={15} /> How it stays private
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              The amount and recipient are encrypted. People can see a payment happened, but never who you paid or how much.
            </p>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex-none text-muted">{k}</span>
      <span className="min-w-0 truncate text-right font-semibold text-ink">{v}</span>
    </div>
  );
}
