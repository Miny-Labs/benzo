/**
 * Convert — the two-way bridge between your two balances, in dead-simple words.
 *   • "Make private"  (mode=private) : move Public USDC into your Private balance
 *                                      (shield → privacy pool). api.importDeposit.
 *   • "Make public"   (mode=public)  : move Private USDC back to your Public
 *                                      balance (unshield → your own address).
 *                                      api.makePublic.
 * Both run the same REAL Groth16/BN254 on-chain op as Cash; we reuse the Cash
 * "journey" done-overlay so the moment feels crafted and honest.
 * The amount you can move is capped by the source balance, surfaced inline.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, Eye, Globe, Lock, ShieldCheck, Smartphone } from "lucide-react";
import { api, type SettleResult } from "../lib/api";
import { apiProverKind, proverPlan } from "../lib/proverPolicy";
import { useWallet } from "../lib/store";
import { fmtUsd } from "../lib/format";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { AmountField, Button } from "../ui/primitives";
import { PrivateChip } from "../ui/privacy";
import { OnChainDetails } from "../ui/OnChainDetails";

type Mode = "private" | "public";
type Phase = "form" | "busy" | "done";

const toS = (a: string): string => BigInt(Math.max(0, Math.round(Number(a) * 1e7) || 0)).toString();

export function Convert() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { balance, publicBalance, refresh, session } = useWallet();
  const [mode, setMode] = useState<Mode>(sp.get("mode") === "public" ? "public" : "private");
  const [amount, setAmount] = useState(() => sp.get("amount") ?? "");
  const [phase, setPhase] = useState<Phase>("form");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<SettleResult | null>(null);

  // The DEVICE decides the proving path. These shield/unshield operations still
  // cross the API boundary, so they delegate to the attested enclave (TEE).
  const teeAvailable = !!session?.prover.available.includes("tee");
  const plan = proverPlan(teeAvailable);

  // Source = where the money comes FROM. Make private pulls from Public; make
  // public pulls from Private. We cap the entry to the source balance.
  const sourceStroops = mode === "private" ? (publicBalance?.stroops ?? "0") : (balance?.stroops ?? "0");
  const source = BigInt(sourceStroops || "0");
  const n = Number(amount);
  const want = BigInt(toS(amount));
  const empty = source <= 0n;
  const tooMuch = want > source;
  const valid = n > 0 && !tooMuch && !empty;
  const inlineError =
    amount && empty
      ? `No ${mode === "private" ? "public" : "private"} USDC available to move.`
      : amount && tooMuch
        ? `Insufficient ${mode === "private" ? "public" : "private"} balance. You only have ${fmtUsd(sourceStroops)}.`
        : null;

  const copy =
    mode === "private"
      ? {
          title: "Make private",
          fromLabel: "From Public",
          toLabel: "To Private",
          fromIcon: <Globe size={14} />,
          toIcon: <Lock size={14} />,
          sub: "Moves it into your private balance — only you can see it.",
          cta: "Make private",
          chip: "Only you can see this",
        }
      : {
          title: "Make public",
          fromLabel: "From Private",
          toLabel: "To Public",
          fromIcon: <Lock size={14} />,
          toIcon: <Globe size={14} />,
          sub: "Moves it to your public balance — ready to send to any wallet.",
          cta: "Make public",
          chip: "Goes to your own public address",
        };

  async function go() {
    setPhase("busy");
    setErr(null);
    try {
      const apiProver = apiProverKind(plan.kind, teeAvailable);
      const r =
        mode === "private"
          ? await api.importDeposit(amount, apiProver) // shield Public → Private (BFF expects dollars, like makePublic)
          : await api.makePublic(amount, apiProver); // unshield Private → your Public
      setResult(r);
      setPhase("done");
      void refresh();
    } catch (e) {
      // Defense in depth: never surface raw CLI/stack text to a person.
      const m = (e as Error).message ?? "";
      const looksRaw = /command failed|stellar |invoke|\s--|0x[0-9a-f]|error\(|panic|sequence|xdr|contract/i.test(m);
      setErr(!m || looksRaw ? "Something went wrong. Your money is safe — please try again." : m);
      setPhase("form");
    }
  }

  return (
    <Screen>
      <ScreenHeader title={copy.title} />
      <div className="px-5 pt-2">
        {/* Direction strip — From → To, so the move is unmistakable */}
        <div className="flex items-center justify-center gap-3 text-[13px] font-semibold" data-testid="convert-direction">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-muted">
            {copy.fromIcon} {copy.fromLabel}
          </span>
          <ArrowRight size={16} className="flex-none text-accent" />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-accent">
            {copy.toIcon} {copy.toLabel}
          </span>
        </div>

        <div className="mt-5">
          <AmountField value={amount} onChange={setAmount} autoFocus />
          <div className="text-center text-[13px] text-muted">{copy.sub}</div>
          <div
            className={`mt-1 text-center text-[12px] ${tooMuch ? "text-[#9a6b12]" : "text-muted/70"}`}
            data-testid="convert-available"
          >
            {empty
              ? `No ${mode === "private" ? "public" : "private"} USDC to move yet`
              : tooMuch
                ? `You only have ${fmtUsd(sourceStroops)} ${mode === "private" ? "public" : "private"}`
                : `${fmtUsd(sourceStroops)} available`}
          </div>
        </div>

        {/* Quick "move all" + presets, clamped to the source balance */}
        <div className="mt-4 flex justify-center gap-2">
          {["20", "50", "100"].map((q) => (
            <button
              key={q}
              type="button"
              disabled={BigInt(toS(q)) > source}
              onClick={() => setAmount(q)}
              className={`rounded-full border px-4 py-1.5 text-[13px] font-semibold transition outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/40 ${amount === q ? "border-accent bg-accent/10 text-accent" : "border-hair bg-card text-ink hover:bg-canvas"}`}
            >
              ${q}
            </button>
          ))}
          <button
            type="button"
            disabled={empty}
            onClick={() => setAmount((Number(source) / 1e7).toString())}
            data-testid="convert-max"
            className="rounded-full border border-hair bg-card px-4 py-1.5 text-[13px] font-semibold text-ink transition outline-none disabled:opacity-40 hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            All
          </button>
        </div>

        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-hair bg-card px-3.5 py-2.5 text-[12.5px] text-muted" data-testid="convert-prover-plan">
          {plan.onDevice ? <Smartphone size={15} className="flex-none text-accent" /> : <ShieldCheck size={15} className="flex-none text-accent" />}
          <span>{plan.reason}</span>
        </div>

        <div className="mt-5 flex justify-center">
          {mode === "private" ? (
            <PrivateChip label={copy.chip} />
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbf1dd] px-2.5 py-1 text-xs font-semibold text-[#9a6b12]">
              <Eye size={12} /> {copy.chip}
            </span>
          )}
        </div>

        <Button full size="lg" className="mt-4" disabled={!valid} loading={phase === "busy"} onClick={go} data-testid="convert-submit">
          <span className="truncate">{copy.cta}{valid ? ` · ${fmtUsd(toS(amount))}` : ""}</span>
        </Button>
        {err || inlineError ? <div className="mt-2 text-center text-sm text-danger" data-testid="convert-error">{err ?? inlineError}</div> : null}
      </div>

      <AnimatePresence>
        {phase === "done" ? <ConvertDone mode={mode} amount={toS(amount)} result={result} onDone={() => nav("/")} /> : null}
      </AnimatePresence>
    </Screen>
  );
}

/** Crafted done overlay — plays the real journey, mirroring Cash's RampDone. */
function ConvertDone({ mode, amount, result, onDone }: { mode: Mode; amount: string; result: SettleResult | null; onDone: () => void }) {
  const onChain = !!result?.onChain;
  const steps =
    mode === "private"
      ? ["Took it from your public balance", "Shielded privately on your device", "Now in your private balance"]
      : ["Unshielded privately", "Sent to your public address", "Now in your public balance"];
  const [lit, setLit] = useState(0);
  useEffect(() => {
    const timers = steps.map((_, i) => setTimeout(() => setLit(i + 1), 420 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-canvas/95 px-8 text-center backdrop-blur-xl"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} data-testid="convert-overlay"
    >
      <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 240, damping: 16 }}
        className="flex h-16 w-16 items-center justify-center rounded-full bg-pos/12 text-pos">
        {mode === "private" ? <Lock size={28} /> : <Globe size={28} />}
      </motion.div>
      <div>
        <div className="font-display text-2xl">{mode === "private" ? "Made private" : "Made public"}</div>
        <div className="mt-1 text-[15px] text-muted">{fmtUsd(amount)}{onChain ? "" : " · not verified on-chain"}</div>
      </div>

      <div className="w-full max-w-[280px] space-y-2.5 text-left">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-3" data-testid="convert-step">
            <motion.div
              animate={{ backgroundColor: i < lit ? "var(--color-pos, #16a34a)" : "rgba(0,0,0,0.06)", scale: i < lit ? 1 : 0.9 }}
              className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-white"
            >
              {i < lit ? <Check size={14} /> : <span className="h-1.5 w-1.5 rounded-full bg-muted" />}
            </motion.div>
            <span className={`text-[13.5px] transition-colors ${i < lit ? "text-ink" : "text-muted"}`}>{s}</span>
          </div>
        ))}
      </div>

      {onChain ? (
        <div className="flex items-center gap-1.5 text-[12px] text-pos" data-testid="convert-proof">
          <ShieldCheck size={13} />
          {mode === "private" ? "Now private — the amount is hidden on-chain" : "Moved to your public balance — ready to send"}
        </div>
      ) : null}
      <div className="w-full max-w-[320px]">
        <OnChainDetails txHash={result?.txHash} prover={result?.prover} provingMs={result?.provingMs} onChain={onChain} kind={mode === "private" ? "shield" : "unshield"} />
      </div>
      <Button className="mt-1" onClick={onDone} data-testid="convert-done">Done</Button>
    </motion.div>
  );
}
