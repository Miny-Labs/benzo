/**
 * Send - three ways to pay, now split cleanly by which BALANCE the money leaves:
 *   • "Send privately"   - to a Benzo @handle, from your PRIVATE balance. Runs the
 *                          real 3-phase ZK ceremony (encrypt → settle → receipt).
 *   • "Send to a wallet" - to any external Stellar G-address, from your PUBLIC
 *                          balance (a real on-chain USDC transfer, api.sendPublic).
 *                          Not private - and we say so plainly.
 *   • invite             - someone with no account yet → an invite link.
 * The ZK proof + on-chain settle are real on testnet.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, AtSign, Globe, Send as SendIcon, ShieldCheck, Smartphone, UserPlus } from "lucide-react";
import { api, currentGoogleCredential, type ProverKind, type SettleResult } from "../lib/api";
import { apiBoundaryProverPlan, proverPlan } from "../lib/proverPolicy";
import { useSendStream } from "../lib/useSendStream";
import { shouldLockOnSend, requireUnlock } from "../lib/lock";
import { mergeContacts } from "../lib/contacts";
import { needsStepUp, stepUpMessage, sendCapUsd } from "../lib/tiers";
import { useWallet } from "../lib/store";
import { fmtUsd } from "../lib/format";
import { isValidStellarAddress, shortAddress } from "../lib/strkey";
import { classifyRecipientInput, hasBadHandleSyntax, looksLikeStellarAddressInput, type RecipientKind } from "../lib/recipient";
import { Screen, motion } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { AmountField, Avatar, Button, Input } from "../ui/primitives";
import { PrivateChip } from "../ui/privacy";
import { OnChainDetails } from "../ui/OnChainDetails";
import { SendCeremony, type SendReceipt } from "../ui/send/SendCeremony";

type Step = "form" | "confirm";
type Kind = RecipientKind;

function toStroopsSafe(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "0";
  return BigInt(Math.round(n * 1e7)).toString();
}

export function Send() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { contacts: bffContacts, session, balance, publicBalance, refresh, refreshBalance } = useWallet();
  const contacts = useMemo(() => mergeContacts(bffContacts), [bffContacts]); // C6: BFF + saved
  const { state, receipt, run, reset } = useSendStream();
  const [to, setTo] = useState(() => params.get("to") ?? ""); // prefilled from Contacts / a request
  const [amount, setAmount] = useState(() => params.get("amount") ?? "");
  const [memo, setMemo] = useState(() => params.get("memo") ?? "");
  const requestId = params.get("requestId") ?? undefined;
  const [step, setStep] = useState<Step>("form");
  const [stepUp, setStepUp] = useState(false); // C5: just-in-time ID step-up sheet
  const [firing, setFiring] = useState(false); // double-tap guard: requireUnlock() awaits before the overlay shows
  // Public-send (to a wallet) runs its own flow - a real on-chain USDC transfer
  // from the PUBLIC balance, not the private ZK ceremony.
  const [pubPhase, setPubPhase] = useState<"idle" | "busy" | "done">("idle");
  const [pubResult, setPubResult] = useState<SettleResult | null>(null);
  const [pubErr, setPubErr] = useState<string | null>(null);
  const [handleStatus, setHandleStatus] = useState<{ value: string; available: boolean | null; checking: boolean; error: boolean }>({ value: "", available: null, checking: false, error: false });
  const overCap = needsStepUp(Number(amount), session?.kycTier);

  // Proving path is local-only: capable desktops prove on-device; API-bound
  // private sends use the local Benzo runtime.
  const plan = useMemo(() => proverPlan(), []);
  const recipient = to.trim();
  const kind = useMemo(() => (recipient ? classifyRecipientInput(recipient) : null), [recipient]);
  const hostedPrivateSend = kind === "handle" && !!currentGoogleCredential();
  const effectivePrivatePlan = useMemo(
    () => hostedPrivateSend ? apiBoundaryProverPlan(plan) : plan,
    [hostedPrivateSend, plan],
  );
  // Looks like a wallet address but the checksum doesn't add up - a typo'd key.
  // Surface this clearly instead of routing it to the "invite" flow or paying it.
  const badAddress = useMemo(() => looksLikeStellarAddressInput(recipient) && !isValidStellarAddress(recipient), [recipient]);
  const badHandle = useMemo(() => hasBadHandleSyntax(recipient), [recipient]);
  const shouldLookupHandle = kind === "handle" && recipient.length > 0 && !badHandle;
  const handleLookupValue = shouldLookupHandle ? recipient.replace(/^@/, "").toLowerCase() : "";
  useEffect(() => {
    if (!shouldLookupHandle) {
      setHandleStatus({ value: "", available: null, checking: false, error: false });
      return;
    }
    let cancelled = false;
    const value = handleLookupValue;
    setHandleStatus({ value, available: null, checking: true, error: false });
    const id = window.setTimeout(() => {
      api.handleAvailable(value)
        .then(({ available }) => {
          if (!cancelled) setHandleStatus({ value, available, checking: false, error: false });
        })
        .catch(() => {
          if (!cancelled) setHandleStatus({ value, available: null, checking: false, error: true });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [handleLookupValue, shouldLookupHandle]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);
  const handleChecking = shouldLookupHandle && handleStatus.value === handleLookupValue && handleStatus.checking;
  const handleLookupError = shouldLookupHandle && handleStatus.value === handleLookupValue && handleStatus.error;
  const unclaimedHandle = shouldLookupHandle && handleStatus.value === handleLookupValue && handleStatus.available === true;
  const known = useMemo(() => contacts.find((c) => c.handle === recipient || c.handle === `@${recipient}`), [contacts, recipient]);
  const display = known?.name ?? recipient;
  // Public sends draw on the PUBLIC balance - flag "not enough" before we ever
  // reach confirm so the user gets a clear shortcut to top it up via Make public.
  const privateStroops = BigInt(balance?.stroops ?? "0");
  const publicStroops = BigInt(publicBalance?.stroops ?? "0");
  const wantStroops = BigInt(toStroopsSafe(amount));
  const checkingPrivateBalance = kind === "handle" && wantStroops > 0n && balance == null && !unclaimedHandle;
  const checkingPublicBalance = kind === "address" && wantStroops > 0n && publicBalance == null;
  const lowPrivate = kind === "handle" && wantStroops > 0n && balance != null && wantStroops > privateStroops;
  const lowPublic = kind === "address" && wantStroops > 0n && publicBalance != null && wantStroops > publicStroops;
  const recipientReady = recipient.length > 0 && Number(amount) > 0 && kind !== "invite" && !badAddress && !badHandle && !handleChecking && !handleLookupError && !unclaimedHandle;
  const canOpenStepUp = overCap && recipientReady;
  const valid = recipientReady && !checkingPrivateBalance && !checkingPublicBalance && !lowPrivate && !(kind === "address" && lowPublic);

  const inFlight = state.phase !== "idle";
  const pubInFlight = pubPhase !== "idle";

  const view: SendReceipt = {
    amount: receipt?.amount ?? toStroopsSafe(amount),
    recipient: display,
    memo: memo || undefined,
    prover: receipt?.prover ?? effectivePrivatePlan.kind,
    onChain: receipt?.onChain ?? false, // honesty-bearing flag: fail honest, not optimistic
    txHash: receipt?.txHash,
    provingMs: receipt?.provingMs,
  };

  async function fire() {
    // Double-tap guard: requireUnlock() awaits while phase is still "idle" (overlay
    // not up yet), so a second tap could launch a second run() = double-send.
    if (firing || inFlight || pubInFlight) return;
    setFiring(true);
    try {
      // Per-send app lock (C4): require the device passkey before money moves.
      // The native platform prompt is the feedback; a cancel leaves us on confirm.
      if (shouldLockOnSend() && !(await requireUnlock())) return;
      if (kind === "address") {
        // "Send to a wallet" - a real on-chain USDC transfer from the PUBLIC
        // balance. No ZK ceremony; this one is public, and we said so.
        setPubPhase("busy");
        setPubErr(null);
        try {
          const r = await api.sendPublic(recipient, amount);
          if (!r.onChain) throw new Error("Payment was not submitted on-chain.");
          setPubResult({ status: "settled", txHash: r.txHash, onChain: true, amount: toStroopsSafe(amount), prover: "local" });
          setPubPhase("done");
          void refresh();
        } catch (e) {
          const m = (e as Error).message ?? "";
          // Map the common trustline failure to dead-simple copy; never show raw CLI.
          const looksRaw = /command failed|stellar |invoke|\s--|0x[0-9a-f]|error\(|panic|sequence|xdr|contract/i.test(m);
          setPubErr(/trustline|isn't set up|not set up/i.test(m) ? "That wallet isn't set up to receive USDC yet." : !m || looksRaw ? "Couldn't send right now. Your money is safe - please try again." : m);
          setPubPhase("idle");
        }
        return;
      }
      // "Send privately" - the @handle path: real 3-phase ZK ceremony.
      await run(recipient, amount, memo || undefined, effectivePrivatePlan.kind, false, requestId);
      void refresh();
    } finally {
      setFiring(false);
    }
  }

  function done() {
    reset();
    setPubPhase("idle");
    setPubResult(null);
    nav("/");
  }

  return (
    <Screen>
      <ScreenHeader title="Send" />
      <div className="px-5 pt-2">
        {step === "form" ? (
          <>
            <Input
              label="To"
              placeholder="@handle or wallet address"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="send-handle"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {/* recipient kind chip (suppressed when the address looks mistyped) */}
            {recipient && !badAddress && !badHandle && !unclaimedHandle ? <KindChip key={kind} kind={kind!} /> : null}
            {badAddress ? (
              <div className="mt-2 flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-[11.5px] font-semibold text-danger" data-testid="send-bad-address">
                <AlertTriangle size={12} /> This doesn't look like a valid wallet address. Double-check it.
              </div>
            ) : null}
            {badHandle ? (
              <div className="mt-2 flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-[11.5px] font-semibold text-danger" data-testid="send-bad-handle">
                <AlertTriangle size={12} /> Handles are 3 to 20 characters: letters, numbers, dots, or underscores.
              </div>
            ) : null}
            {handleChecking ? (
              <div className="mt-2 text-[12px] font-medium text-muted" data-testid="send-handle-checking">Checking handle...</div>
            ) : null}
            {handleLookupError ? (
              <div className="mt-2 flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-[11.5px] font-semibold text-danger" data-testid="send-handle-lookup-error">
                <AlertTriangle size={12} /> Couldn't check that handle. Try again.
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {contacts.map((c) => (
                <button
                  key={c.handle}
                  onClick={() => setTo(c.handle)}
                  className={`flex max-w-[10rem] items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[13px] font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    recipient === c.handle ? "border-accent bg-accent/10 text-accent" : "border-hair bg-card text-ink hover:bg-canvas"
                  }`}
                >
                  <Avatar name={c.name} tone={c.tone} size={26} />
                  <span className="min-w-0 truncate">{c.handle}</span>
                </button>
              ))}
            </div>

            <div className="mt-6">
              <AmountField value={amount} onChange={setAmount} autoFocus />
              <div className="text-center text-[13px] text-muted">{display ? `to ${display}` : "Enter an amount"}</div>
              {overCap ? (
                <div className="mx-auto mt-2 max-w-[280px] text-center text-[12px] text-[#9a6b12]" data-testid="send-overcap-hint">
                  Sends over ${sendCapUsd(session?.kycTier).toLocaleString()} need a quick one-time ID check.
                </div>
              ) : null}
              {lowPublic && !canOpenStepUp ? (
                <div className="mx-auto mt-2 flex max-w-[300px] flex-col items-center gap-1.5 text-center text-[12px] text-[#9a6b12]" data-testid="send-low-public">
                  <span>Not enough public USDC - Make public first.</span>
                  <button
                    type="button"
                    onClick={() => nav(`/convert?mode=public&amount=${encodeURIComponent(amount)}`)}
                    data-testid="send-make-public"
                    className="inline-flex items-center gap-1 rounded-full bg-[#fbf1dd] px-3 py-1 font-semibold text-[#9a6b12] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <Globe size={12} /> Make public
                  </button>
                </div>
              ) : null}
              {checkingPublicBalance ? (
                <div className="mx-auto mt-2 max-w-[300px] text-center text-[12px] text-muted" data-testid="send-public-balance-checking">
                  Checking public balance...
                </div>
              ) : null}
              {lowPrivate && !canOpenStepUp ? (
                <div className="mx-auto mt-2 max-w-[300px] text-center text-[12px] text-[#9a6b12]" data-testid="send-low-private">
                  Not enough private USDC. Add money or use a smaller amount.
                </div>
              ) : null}
              {checkingPrivateBalance ? (
                <div className="mx-auto mt-2 max-w-[300px] text-center text-[12px] text-muted" data-testid="send-private-balance-checking">
                  Checking private balance...
                </div>
              ) : null}
              <div className="mt-3 flex justify-center gap-2">
                {["5", "10", "20", "50", "100"].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setAmount(q)}
                    className={`rounded-full border px-3 py-1.5 text-[13px] font-semibold transition outline-none active:scale-95 focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      amount === q ? "border-accent bg-accent/10 text-accent" : "border-hair bg-card text-ink hover:bg-canvas"
                    }`}
                  >
                    ${q}
                  </button>
                ))}
              </div>
            </div>

            <Input className="mt-6" label="Note (optional)" placeholder="What's it for?" value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="send-memo" />

            {((kind === "invite" && recipient) || unclaimedHandle) && !badAddress && !badHandle ? (
              <div className="mt-6 flex items-center gap-3 rounded-2xl bg-accent/[0.06] p-4">
                <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent/15 text-accent">
                  <UserPlus size={17} />
                </div>
                <div className="flex-1 text-[13px] text-ink">
                  <b>{recipient}</b> isn't on Benzo yet.
                  <div className="text-muted">Send them a link they can claim.</div>
                </div>
                <Button size="sm" onClick={() => nav(`/invite?to=${encodeURIComponent(recipient)}&amount=${encodeURIComponent(amount)}`)} data-testid="send-invite">
                  Invite
                </Button>
              </div>
            ) : null}

            {kind !== "invite" && !unclaimedHandle ? (
              <Button full size="lg" className="mt-6" disabled={!valid && !canOpenStepUp} onClick={() => (overCap ? setStepUp(true) : setStep("confirm"))} data-testid="send-submit">
                {amount && (valid || canOpenStepUp) ? `${overCap ? "Verify" : "Review"} · ${fmtUsd(toStroopsSafe(amount))}` : "Review"}
              </Button>
            ) : null}
          </>
        ) : (
          <ConfirmStep
            kind={kind!}
            display={display}
            address={kind === "address" ? recipient : undefined}
            amount={toStroopsSafe(amount)}
            memo={memo}
            plan={effectivePrivatePlan}
            isNewRecipient={!known && kind === "handle"}
            firing={firing || pubPhase === "busy"}
            pubErr={kind === "address" ? pubErr : null}
            onBack={() => setStep("form")}
            onSend={fire}
          />
        )}
      </div>

      {inFlight ? <SendCeremony state={state} receipt={view} onDone={done} onRetry={() => { reset(); setStep("confirm"); }} /> : null}
      {pubPhase === "done" ? <PublicSendDone display={display} address={recipient} amount={toStroopsSafe(amount)} result={pubResult} onDone={done} /> : null}
      {stepUp ? <StepUpSheet message={stepUpMessage(Number(amount), session?.kycTier)} onClose={() => setStepUp(false)} /> : null}
    </Screen>
  );
}

/** Done overlay for "Send to a wallet" - a public on-chain USDC payout. Honest:
 *  this one isn't private, and the receipt links the real settlement tx. Mirrors
 *  the crafted Cash/Convert done moment rather than a fleeting toast. */
function PublicSendDone({ display, address, amount, result, onDone }: { display: string; address: string; amount: string; result: SettleResult | null; onDone: () => void }) {
  const onChain = !!result?.onChain;
  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-canvas px-8 text-center"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} data-testid="send-public-overlay"
    >
      <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 240, damping: 16 }}
        className="flex h-16 w-16 items-center justify-center rounded-full bg-pos/12 text-pos">
        <Globe size={28} />
      </motion.div>
      <div>
        <div className="font-display text-2xl" data-testid="send-public-title">Sent to a wallet</div>
        <div className="mt-1 text-[15px] text-muted">{fmtUsd(amount)}{onChain ? "" : " · not verified on-chain"}</div>
        <div className="mt-1 text-[13px] text-muted">to {shortAddress(address)}</div>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbf1dd] px-3 py-1 text-xs font-semibold text-[#9a6b12]">
        <Globe size={13} /> This one is public, not private.
      </span>
      <div className="w-full max-w-[320px]"><OnChainDetails txHash={result?.txHash} onChain={onChain} kind="public" /></div>
      <Button className="mt-1" onClick={onDone} data-testid="send-public-done">Done</Button>
    </motion.div>
  );
}

/** Just-in-time ID step-up (C5). Honest: the real bump runs through a verification
 *  provider; we don't claim success without a provider result. The ID never goes on-chain. */
function StepUpSheet({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-50 flex flex-col justify-end bg-ink/30 backdrop-blur-sm"
      data-testid="send-stepup"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 40 }}
        animate={{ y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-t-[28px] bg-card px-6 pb-8 pt-6"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink/15" />
        <div className="mb-1 flex items-center gap-2">
          <ShieldCheck size={18} className="text-accent" />
          <h2 className="font-display text-lg">Verify to send more</h2>
        </div>
        <p className="text-[13.5px] leading-relaxed text-muted">{message}</p>
        <Button full size="lg" className="mt-5" onClick={onClose} data-testid="stepup-verify">Verify identity</Button>
        <button onClick={onClose} className="mt-3 w-full rounded-lg py-1 text-center text-[14px] font-semibold text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="stepup-later">Maybe later</button>
      </motion.div>
    </motion.div>
  );
}

function KindChip({ kind }: { kind: Kind }) {
  const map = {
    handle: { icon: <AtSign size={12} />, text: "Send privately. Only you two see it", cls: "bg-accent/10 text-accent" },
    address: { icon: <Globe size={12} />, text: "Send to a wallet. This one is public, not private", cls: "bg-[#fbf1dd] text-[#9a6b12]" },
    invite: { icon: <UserPlus size={12} />, text: "Not on Benzo yet. Invite them", cls: "bg-ink/[0.05] text-muted" },
  }[kind];
  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${map.cls}`}
      data-testid="send-kind"
    >
      {map.icon}
      {map.text}
    </motion.div>
  );
}

function ConfirmStep({
  kind,
  display,
  address,
  amount,
  memo,
  plan,
  isNewRecipient,
  firing,
  pubErr,
  onBack,
  onSend,
}: {
  kind: Kind;
  display: string;
  address?: string;
  amount: string;
  memo: string;
  plan: { onDevice: boolean; kind: ProverKind; reason: string };
  isNewRecipient: boolean;
  firing: boolean;
  pubErr?: string | null;
  onBack: () => void;
  onSend: () => void;
}) {
  return (
    <div>
      <div className="mt-2 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)]">
        <div className="text-center">
          <div className="font-display tnum text-4xl text-ink">{fmtUsd(amount)}</div>
          {/* For a public address, show the truncated parsed key so the user can
              eyeball the real on-chain destination - not just a display name. */}
          {kind === "address" && address ? (
            <div className="mx-auto mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 font-mono text-[13px] text-ink" data-testid="confirm-address">
              <Globe size={12} className="flex-none text-[#9a6b12]" /> {shortAddress(address)}
            </div>
          ) : (
            <div className="mx-auto mt-1 max-w-full truncate px-4 text-sm text-muted">to {display}</div>
          )}
        </div>
        {memo ? <div className="mt-3 rounded-xl bg-canvas/70 px-3 py-2 text-center text-sm text-ink">"{memo}"</div> : null}
        <div className="mt-4 flex justify-center">
          {kind === "address" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbf1dd] px-3 py-1 text-xs font-semibold text-[#9a6b12]">
              <Globe size={13} /> Public payout. This one isn't private.
            </span>
          ) : (
            <PrivateChip label={`Only you and ${display} can see this`} />
          )}
        </div>
      </div>

      {kind === "address" ? (
        <div className="mt-3 flex items-start gap-2 rounded-2xl bg-[#fbf1dd] px-3.5 py-2.5 text-sm text-[#9a6b12]" data-testid="send-address-trustline">
          <AlertTriangle size={15} className="mt-0.5 flex-none" />
          <span>
            <b>Public address payout.</b> This address must already be set up to receive USDC - if it isn't, the payment can't land. Sends are instant and final, so double-check it.
          </span>
        </div>
      ) : isNewRecipient ? (
        <div className="mt-3 flex items-start gap-2 rounded-2xl bg-[#fbf1dd] px-3.5 py-2.5 text-sm text-[#9a6b12]" data-testid="send-new-recipient">
          <AlertTriangle size={15} className="mt-0.5 flex-none" />
          <span>
            <b>First time paying {display}.</b> Sends are instant and final, so double-check the handle is right.
          </span>
        </div>
      ) : (
        <div className="mt-3 text-center text-sm text-muted">
          Sends instantly and can't be undone - double-check the {display.startsWith("@") ? "" : "@"}handle.
        </div>
      )}

      {kind === "address" ? (
        // A public send leaves the PUBLIC balance - no ZK proving here, so say
        // exactly what's happening instead of showing the private prover plan.
        <div className="mt-5 flex items-center gap-2 rounded-2xl border border-hair bg-card px-3.5 py-2.5 text-xs text-muted" data-testid="send-public-note">
          <Globe size={15} className="flex-none text-[#9a6b12]" />
          <span>Paid from your Public balance - a normal USDC payment any wallet can receive.</span>
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-2 rounded-2xl border border-hair bg-card px-3.5 py-2.5 text-xs text-muted" data-testid="send-prover-plan">
          {plan.onDevice ? <Smartphone size={15} className="flex-none text-accent" /> : <ShieldCheck size={15} className="flex-none text-accent" />}
          <span>{plan.reason}</span>
        </div>
      )}

      {pubErr ? <div className="mt-3 text-center text-sm text-danger" data-testid="send-public-error">{pubErr}</div> : null}

      <div className="mt-6 flex gap-3">
        <Button variant="secondary" size="lg" onClick={onBack} disabled={firing} data-testid="send-back">
          Back
        </Button>
        <Button full size="lg" loading={firing} disabled={firing} onClick={onSend} data-testid="send-confirm">
          {kind === "address" ? <Globe size={17} className="flex-none" /> : <SendIcon size={17} className="flex-none" />}
          <span className="truncate">{kind === "address" ? "Send to wallet" : "Send"} {fmtUsd(amount)}</span>
        </Button>
      </div>
    </div>
  );
}
