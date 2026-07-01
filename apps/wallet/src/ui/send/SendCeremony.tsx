/**
 * The 3-phase send ceremony (S0). A full-screen overlay driven by the shared
 * payment state machine (@benzo/ui): phase 1 encrypts (coin → cipher + closing
 * lock ring), phase 2 settles (coin drops into a block stack), phase 3 reveals a
 * verifiable receipt. The animation is a slave to the machine - never a timer -
 * so it tells the truth about proving/settlement. Collapses to a calm, labeled
 * step list under prefers-reduced-motion.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, Copy, ExternalLink, ShieldCheck, X } from "lucide-react";
import { sendCeremonyView, SEND_RAIL_LABELS } from "@benzo/ui/send-sequence";
import { type PaymentState } from "@benzo/ui/payment-state";
import { EASE, spring } from "../motion";
import { Button, SuccessCheck } from "../primitives";
import { copyTextToClipboard } from "../../lib/clipboard";
import { fmtUsd } from "../../lib/format";
import { explorerTx } from "../OnChainDetails";

export interface SendReceipt {
  amount: string; // stroops
  recipient: string; // @handle or display name
  memo?: string;
  txHash?: string;
  onChain: boolean;
  provingMs?: number;
  prover: "local" | "tee";
}

/** Network-aware tx explorer URL. Re-exported from the single source (OnChainDetails)
 *  so a mainnet build never deep-links the testnet explorer (was hardcoded "testnet"). */
export const explorerTxUrl = explorerTx;

export function SendCeremony({
  state,
  receipt,
  onDone,
  onRetry,
}: {
  state: PaymentState;
  receipt: SendReceipt;
  onDone: () => void;
  onRetry: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const view = sendCeremonyView(state, { prover: receipt.prover, reducedMotion: reduce });
  if (state.phase === "idle") return null;

  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-between bg-canvas px-8 pb-10 pt-14 text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-testid="send-overlay"
    >
      <PhaseRail step={view.step} failed={view.failed} reduce={reduce} />

      <div className="flex flex-1 flex-col items-center justify-center gap-5">
        <AnimatePresence mode="wait">
          {view.phase === "encrypt" ? (
            <Stage key="encrypt">
              <CoinEncrypt reduce={reduce} />
            </Stage>
          ) : view.phase === "settle" ? (
            <Stage key="settle">
              <BlocksSettling reduce={reduce} />
            </Stage>
          ) : view.phase === "verify" ? (
            <Stage key="verify">
              <VerifyReveal receipt={receipt} reduce={reduce} />
            </Stage>
          ) : (
            <Stage key="error">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-danger/12 text-danger">
                <X size={34} />
              </div>
            </Stage>
          )}
        </AnimatePresence>

        <div>
          <div className="font-display text-2xl" data-testid="ceremony-title">
            {view.phase === "verify" ? "Sent privately" : view.title}
          </div>
          <div className="mt-1 text-sm text-muted" data-testid="ceremony-sub">
            {view.sub}
          </div>
        </div>
      </div>

      <div className="w-full">
        {view.done ? (
          <Button full size="lg" onClick={onDone} data-testid="ceremony-done">
            Done
          </Button>
        ) : view.failed ? (
          <Button full size="lg" variant="secondary" onClick={onRetry} data-testid="ceremony-retry">
            Try again
          </Button>
        ) : (
          <SlowReassurance phase={view.phase} onEscape={onRetry} />
        )}
      </div>
    </motion.div>
  );
}

// ----------------------------------------------------------------- rail
function PhaseRail({ step, failed, reduce }: { step: number; failed: boolean; reduce: boolean }) {
  return (
    <div className="flex w-full max-w-[280px] items-center gap-2" aria-hidden={!reduce}>
      {SEND_RAIL_LABELS.map((label, i) => {
        const active = step >= 0 && i <= step;
        const isCurrent = i === step && !failed;
        return (
          <div key={label} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.08]">
              <motion.div
                className={`absolute inset-y-0 left-0 rounded-full ${failed && isCurrent ? "bg-danger" : "bg-accent"}`}
                initial={false}
                animate={{ width: active || (failed && i <= Math.max(step, 0)) ? "100%" : "0%" }}
                transition={{ duration: reduce ? 0 : 0.4, ease: EASE }}
              />
            </div>
            <span className={`text-[10px] font-semibold uppercase tracking-wide ${active ? "text-accent" : "text-muted/60"}`}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex flex-col items-center"
    >
      {children}
    </motion.div>
  );
}

// ----------------------------------------------------------------- phase 1: encrypt
const GLYPHS = "0123456789abcdef∎▚▞◆◈⬡".split("");

function CoinEncrypt({ reduce }: { reduce: boolean }) {
  const [cipher, setCipher] = useState("$");
  useEffect(() => {
    if (reduce) return;
    let on = true;
    const id = setInterval(() => {
      if (!on) return;
      setCipher(
        Array.from({ length: 3 }, () => GLYPHS[Math.floor(performance.now() / 73 + Math.random() * GLYPHS.length) % GLYPHS.length]).join(""),
      );
    }, 125); // ~8fps, capped
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [reduce]);

  return (
    <div className="relative flex h-28 w-28 items-center justify-center">
      {/* closing lock ring */}
      {!reduce ? (
        <motion.svg className="absolute inset-0" viewBox="0 0 100 100">
          <motion.circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke="var(--color-accent, #7342E2)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="289"
            initial={{ strokeDashoffset: 289, rotate: -90 }}
            animate={{ strokeDashoffset: [289, 40, 289] }}
            transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
            style={{ transformOrigin: "50% 50%", rotate: -90 }}
          />
        </motion.svg>
      ) : (
        <div className="absolute inset-0 rounded-full border-[3px] border-accent/30" />
      )}
      {/* coin */}
      <motion.div
        className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-accent to-[#9a6bff] text-white shadow-[var(--shadow-glow)]"
        animate={reduce ? {} : { scale: [1, 1.04, 1] }}
        transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
      >
        <span className="font-display tnum text-xl tracking-tight">{reduce ? <ShieldCheck size={26} /> : cipher}</span>
      </motion.div>
    </div>
  );
}

// ----------------------------------------------------------------- phase 2: settle
function BlocksSettling({ reduce }: { reduce: boolean }) {
  return (
    <div className="relative flex h-28 w-28 flex-col items-center justify-end gap-1.5">
      <motion.div
        className="absolute top-0 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-accent to-[#9a6bff] text-white shadow-[var(--shadow-glow)]"
        initial={{ y: reduce ? 0 : -8, opacity: reduce ? 1 : 0 }}
        animate={{ y: reduce ? 0 : 56, opacity: 1 }}
        transition={reduce ? { duration: 0 } : { ...spring, delay: 0.05 }}
      >
        <ShieldCheck size={16} />
      </motion.div>
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="h-4 w-20 rounded-md bg-ink/[0.08]"
          initial={{ scaleX: reduce ? 1 : 0.4, opacity: reduce ? 1 : 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={reduce ? { duration: 0 } : { ...spring, delay: 0.12 * i }}
        />
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- phase 3: verify
function VerifyReveal({ receipt, reduce }: { receipt: SendReceipt; reduce: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "To", value: receipt.recipient },
    { label: "Amount", value: fmtUsd(receipt.amount) },
  ];
  if (receipt.memo) rows.push({ label: "Note", value: receipt.memo });

  return (
    <div className="flex w-full max-w-[300px] flex-col items-center gap-4">
      <SuccessCheck size={76} />
      <div className="w-full rounded-2xl bg-card p-4 shadow-[var(--shadow-card)]">
        {rows.map((r, i) => (
          <motion.div
            key={r.label}
            className="flex items-center justify-between border-b border-hair/60 py-2 text-sm last:border-0"
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduce ? 0 : 0.1 + i * 0.07, ease: EASE }}
          >
            <span className="text-muted">{r.label}</span>
            <span className="font-semibold text-ink">{r.value}</span>
          </motion.div>
        ))}
        <div className="mt-3 flex items-center justify-center gap-1.5 text-[12px] font-medium text-pos">
          <ShieldCheck size={13} /> Private payment{receipt.onChain ? "" : " · not verified on-chain"}
        </div>
        <div className="mt-2 flex flex-col items-center">
          <button
            onClick={() => setShowDetails((s) => !s)}
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-ink"
            data-testid="receipt-details-toggle"
          >
            {showDetails ? "Hide details" : "Receipt details"}
            <ChevronDown size={13} className={`transition-transform ${showDetails ? "rotate-180" : ""}`} />
          </button>
          <AnimatePresence initial={false}>
            {showDetails ? (
              <motion.div
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }}
                className="mt-2 flex flex-wrap items-center justify-center gap-2"
              >
                {typeof receipt.provingMs === "number" ? (
                  <span className="rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11px] font-semibold text-muted">Proved in {(receipt.provingMs / 1000).toFixed(1)}s</span>
                ) : null}
                {receipt.txHash && receipt.onChain ? (
                  <a
                    href={explorerTxUrl(receipt.txHash)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-ink/10"
                    data-testid="receipt-explorer"
                  >
                    <ExternalLink size={12} /> View receipt
                  </a>
                ) : null}
                {receipt.txHash ? <CopyChip text={receipt.txHash} /> : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
      <p className="text-[12px] text-muted">Only you and {receipt.recipient} can see this.</p>
    </div>
  );
}

function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void copyTextToClipboard(text).then(setCopied);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-ink/10"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Reference"}
    </button>
  );
}

// ----------------------------------------------------------------- slow reassurance
// Three honest stages: quiet (no message), reassurance (~6-8s), and a hard ceiling
// (~90s) that offers a safe escape WITHOUT claiming failure - the submit→poll loop
// can legitimately run long, but the user should never be stranded forever.
const STALL_CEILING_MS = 90_000;
function SlowReassurance({ phase, onEscape }: { phase: "encrypt" | "settle" | "verify" | "error"; onEscape: () => void }) {
  const [slow, setSlow] = useState(false);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setSlow(false);
    setStalled(false);
    const slowId = setTimeout(() => setSlow(true), phase === "encrypt" ? 6000 : 8000);
    const stallId = setTimeout(() => setStalled(true), STALL_CEILING_MS);
    return () => {
      clearTimeout(slowId);
      clearTimeout(stallId);
    };
  }, [phase]);
  if (stalled) {
    return (
      <div className="flex flex-col items-center gap-2 px-4" data-testid="ceremony-stalled">
        <p className="text-[13px] text-muted">Taking longer than usual. The network may be busy - your money hasn't moved yet.</p>
        <button onClick={onEscape} className="text-[13px] font-semibold text-accent" data-testid="ceremony-stalled-retry">
          Start over
        </button>
      </div>
    );
  }
  if (!slow) return <div className="h-[52px]" />;
  return (
    <p className="px-4 text-[13px] text-muted">
      {phase === "encrypt" ? "Strong proofs take a few seconds. Your money hasn't moved yet." : "Waiting for the ledger to close…"}
    </p>
  );
}
