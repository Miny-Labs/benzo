/**
 * TxDetail (C3) - the per-payment receipt every money app has and we were missing
 * (Wise/Cash App parity). Reached at /activity/:id; reads the row straight from
 * the already-loaded history, so it is fully client-side - no extra backend call.
 *
 * Shows: the amount + who, a plain-English status timeline (created → proved
 * private → settled), the privacy posture, a reference, the full date, and two
 * actions - view the on-chain receipt (explorer) and share a provable receipt.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, ExternalLink, FileSearch, Globe2, Landmark, ShieldCheck, X } from "lucide-react";
import { useWallet } from "../lib/store";
import { fullDateTime } from "../lib/format";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { Avatar, Button, EmptyState } from "../ui/primitives";
import { AmountText } from "../ui/money";
import { PrivateChip, ProvableChip } from "../ui/privacy";
import { explorerTxUrl } from "../ui/send/SendCeremony";
import type { ActivityRow } from "../lib/api";

type StepState = "done" | "active" | "failed" | "upcoming";
interface Step {
  label: string;
  hint?: string;
  state: StepState;
}

/** Cash-style rows (add money / cash out / shield / unshield) vs a person-to-person payment. */
function isCashRow(row: ActivityRow): boolean {
  return row.type === "cashOut" || row.type === "unshield" || row.type === "shield" || row.type === "cashIn";
}

function isMakePublicRow(row: ActivityRow): boolean {
  return row.type === "makePublic" || row.name === "Made public" || row.note.includes("Public balance");
}

function isPublicSendRow(row: ActivityRow): boolean {
  return row.type === "publicSend" || row.note === "Public send";
}

/** Build the status timeline for a row - the steps + which one we're on. */
function timeline(row: ActivityRow): Step[] {
  const failed = row.status === "failed";
  const settled = row.status === "settled";
  if (isPublicSendRow(row)) {
    return [
      { label: "Public payment created", state: "done" },
      {
        label: failed ? "Public send failed" : settled ? "Sent on Stellar testnet" : "Sending on Stellar testnet",
        hint: "Recipient and amount are public on-chain",
        state: failed ? "failed" : settled ? "done" : "active",
      },
      {
        label: settled ? "Settled" : "Settling",
        state: failed ? "upcoming" : settled ? "done" : "active",
      },
    ];
  }
  if (isMakePublicRow(row)) {
    return [
      { label: "Make-public created", state: "done" },
      { label: "Proved private", hint: "The source balance stayed hidden", state: failed ? "failed" : "done" },
      {
        label: settled ? "Moved to Public balance" : "Moving to Public balance",
        hint: settled ? undefined : "Stellar testnet settlement",
        state: failed ? "upcoming" : settled ? "done" : "active",
      },
    ];
  }
  // Off-ramp simulation (cash out / unshield): created, proved private, returned to reserve.
  if (row.type === "cashOut" || row.type === "unshield") {
    return [
      { label: "Cash-out created", state: "done" },
      { label: "Proved private", hint: "Your balance stayed hidden", state: failed ? "failed" : "done" },
      {
        label: settled ? "Returned to testnet reserve" : "Returning to testnet reserve",
        hint: settled ? undefined : "Stellar testnet settlement",
        state: failed ? "upcoming" : settled ? "done" : "active",
      },
    ];
  }
  // On-ramp (add money): received → added.
  if (row.type === "cashIn" || row.type === "shield") {
    return [
      { label: "Funds received", state: "done" },
      { label: "Added to your balance", state: failed ? "failed" : "done" },
    ];
  }
  // Incoming payment.
  if (row.direction === "in") {
    return [
      { label: "Payment received", state: "done" },
      { label: "Settled", state: failed ? "failed" : "done" },
    ];
  }
  // Outgoing private payment - the ZK story, told plainly.
  if (failed) {
    return [
      { label: "Payment attempt created", state: "done" },
      {
        label: "Private proof did not complete",
        hint: "No on-chain settlement was recorded",
        state: "failed",
      },
      { label: "Not settled", state: "upcoming" },
    ];
  }
  return [
    { label: "Payment created", state: "done" },
    {
      label: "Proved private",
      hint: "Amount and recipient stayed hidden",
      state: failed ? "failed" : row.status === "proving" ? "active" : "done",
    },
    {
      label: settled ? "Settled" : "Settling",
      state: failed ? "upcoming" : settled ? "done" : row.status === "proving" ? "upcoming" : "active",
    },
  ];
}

export function TxDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { history, hidden } = useWallet();
  const row = useMemo(() => history.find((r) => r.id === id), [history, id]);

  if (!row) {
    return (
      <Screen>
        <ScreenHeader title="Details" />
        <div className="px-5 pt-10">
          <EmptyState icon={<FileSearch size={28} />} title="Payment not found" hint="It may still be loading. Head back to your activity." />
          <Button full className="mt-5" onClick={() => nav("/activity")}>
            Back to activity
          </Button>
        </div>
      </Screen>
    );
  }

  const cash = isCashRow(row);
  const makePublic = isMakePublicRow(row);
  const publicSend = isPublicSendRow(row);
  const steps = timeline(row);
  // Honest on-chain claim: a legacy local row never counts as "Verified on-chain",
  // even if it carries a txHash - otherwise we'd link a dead explorer tx.
  const onChain = !row.unverified && !!row.txHash;
  const privatePayment = row.type !== "cashOut" && row.type !== "unshield" && !publicSend;
  const amountDirection = row.status === "failed" ? undefined : row.direction;
  const counterpartyPrefix =
    row.status === "failed" && row.direction === "out"
      ? "attempted to"
      : row.direction === "in"
        ? "from"
        : "to";

  return (
    <Screen>
      <ScreenHeader title="Details" />
      <div className="px-5 pt-2">
        {/* amount + who */}
        <div className="flex flex-col items-center pt-3 text-center">
          {cash ? (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#e7e0fb] text-[#4a2fa0]">
              <Landmark size={24} />
            </div>
          ) : (
            <Avatar name={row.name} tone={row.tone} size={56} />
          )}
          <div className="mt-3" data-testid="txdetail-amount">
            <AmountText stroops={hidden ? "0" : row.amount} direction={amountDirection} className="text-[40px]" />
          </div>
          <div className="mt-1 max-w-full px-4 text-[14px] text-muted">
            {counterpartyPrefix} <span className="font-semibold text-ink">{row.name}</span>
          </div>
          {row.unverified ? (
            <span className="mt-2 inline-flex items-center rounded-full bg-muted/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted" title="Not verified on-chain" data-testid="txdetail-unverified">
              Unverified
            </span>
          ) : null}
          <div className="mt-3">
            {publicSend ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbf1dd] px-3 py-1 text-[12px] font-semibold text-[#9a6b12]">
                <Globe2 size={13} /> Public Stellar payment
              </span>
            ) : row.status === "failed" ? (
              <PrivateChip label="No on-chain transfer recorded" />
            ) : privatePayment ? (
              <PrivateChip label={cash ? "Your balance stayed private" : `Only you and ${row.name} can see this`} />
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbf1dd] px-3 py-1 text-[12px] font-semibold text-[#9a6b12]">
                <Landmark size={13} /> {makePublic ? "Made public" : "Testnet reserve cash-out"}
              </span>
            )}
          </div>
        </div>

        {/* status timeline */}
        <div className="mt-7 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)]" data-testid="txdetail-timeline">
          {steps.map((s, i) => (
            <TimelineRow key={s.label} step={s} last={i === steps.length - 1} index={i} />
          ))}
        </div>

        {/* details */}
        <div className="mt-4 space-y-3 rounded-[var(--radius-card)] bg-card p-5 text-[13.5px] shadow-[var(--shadow-card)]">
          {row.note ? <DRow k="Note" v={`"${row.note}"`} /> : null}
          <DRow k="Date" v={fullDateTime(row.timestamp)} />
          <DRow k="Reference" v={<span className="font-mono text-[12px]">{row.id.slice(0, 12)}</span>} />
          <DRow
            k="Privacy"
            v={
              <span className={`inline-flex items-center gap-1.5 ${publicSend ? "text-[#9a6b12]" : "text-pos"}`}>
                {publicSend ? <Globe2 size={14} /> : <ShieldCheck size={14} />} {publicSend ? "Public" : privatePayment ? "Private" : "Amount private"}
              </span>
            }
          />
          {onChain ? <DRow k="Proof" v={<ProvableChip label="Verified on-chain" />} /> : null}
        </div>

        {/* actions */}
        <div className="mt-5 flex flex-col gap-2.5 pb-8">
          {onChain ? (
            <a
              href={explorerTxUrl(row.txHash!)}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="txdetail-explorer"
              className="flex items-center justify-center gap-2 rounded-full border border-hair bg-card py-3 text-[14px] font-semibold text-ink transition hover:bg-canvas"
            >
              <ExternalLink size={16} /> View receipt
            </a>
          ) : null}
          {onChain && privatePayment ? (
            <Button variant="secondary" full onClick={() => nav("/share-proof")} data-testid="txdetail-share">
              <ShieldCheck size={16} /> Share a provable receipt
            </Button>
          ) : null}
        </div>
      </div>
    </Screen>
  );
}

function TimelineRow({ step, last, index }: { step: Step; last: boolean; index: number }) {
  const dot =
    step.state === "done"
      ? "bg-pos text-white"
      : step.state === "active"
        ? "bg-accent text-white"
        : step.state === "failed"
          ? "bg-danger text-white"
          : "bg-hair text-muted";
  const line = step.state === "done" ? "bg-pos/40" : "bg-hair";
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: index * 0.06, type: "spring", stiffness: 500, damping: 28 }}
          className={`flex h-6 w-6 flex-none items-center justify-center rounded-full ${dot}`}
        >
          {step.state === "failed" ? <X size={13} /> : step.state === "active" ? <span className="h-2 w-2 rounded-full bg-white" /> : <Check size={13} />}
        </motion.div>
        {!last ? <div className={`my-1 w-0.5 flex-1 ${line}`} style={{ minHeight: 18 }} /> : null}
      </div>
      <div className={`pb-3 ${last ? "" : ""}`}>
        <div className={`text-[14px] font-semibold ${step.state === "upcoming" ? "text-muted" : "text-ink"}`}>{step.label}</div>
        {step.hint ? <div className="text-[12px] text-muted">{step.hint}</div> : null}
      </div>
    </div>
  );
}

function DRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex-none text-muted">{k}</span>
      <span className="min-w-0 break-words text-right font-medium text-ink">{v}</span>
    </div>
  );
}
