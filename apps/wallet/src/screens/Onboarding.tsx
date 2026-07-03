/**
 * Onboarding (P0-1) - a 3-step first-run: a one-screen splash, sign-in (on-device
 * passkey first, Google zkLogin as the alternate), then claim your @handle. Keys
 * are derived on THIS device via the passkey (no server custodian); the handle is
 * registered on-chain so people can pay you by name. Dismissal persists, so it
 * shows once.
 *
 * Testnet note: the passkey step proves on-device key custody for real; funded
 * operating flows use local proving and fail clearly if that runtime is absent.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Eye, Fingerprint, Loader2, Send, ShieldCheck, X } from "lucide-react";
import { LogoMark } from "../ui/Logo";
import { Button } from "../ui/primitives";
import { fadeUp, stagger, EASE } from "../ui/motion";
import { api, clearGoogleCredential, currentGoogleCredential, storeGoogleCredential } from "../lib/api";
import { friendlyError } from "../lib/errors";
import { useWallet } from "../lib/store";
import { createDeviceAuthProof, registerPasskey, loginWithPasskey, isWebAuthnAvailable } from "../lib/passkey";

type Step = "welcome" | "auth" | "handle";

// Real Google sign-in is enabled only when a client id is configured at build time.
// Without it, the wallet uses the passkey/device path only; no placeholder provider auth.
const GOOGLE_CLIENT_ID_FALLBACK = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID || "";
declare global {
  interface Window {
    google?: {
      accounts?: { id?: { initialize: (o: Record<string, unknown>) => void; renderButton: (el: HTMLElement, o: Record<string, unknown>) => void } };
    };
  }
}

const POINTS = [
  { icon: <Eye size={18} />, title: "Only you can see it", body: "Your balance and payments stay yours. Nobody else can look." },
  { icon: <Send size={18} />, title: "Send like a text", body: "Pay any @handle. No addresses, no gas, no waiting." },
  { icon: <ShieldCheck size={18} />, title: "Prove it without showing it", body: "Show you hold enough, or that you got paid. Never the amount." },
];

function isLocalVerificationUi(): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

const LOCAL_VERIFICATION_SUBJECT_KEY = "benzo.localVerificationSubject";

function localVerificationSubject(): string {
  const existing = localStorage.getItem(LOCAL_VERIFICATION_SUBJECT_KEY);
  if (existing) return existing;
  const subject = `codex-wallet-ui-${crypto.randomUUID?.() ?? Date.now().toString(36)}`;
  localStorage.setItem(LOCAL_VERIFICATION_SUBJECT_KEY, subject);
  return subject;
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  return (
    <motion.div
      className="absolute inset-0 z-[70] flex flex-col bg-canvas"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-testid="onboarding"
    >
      <AnimatePresence mode="wait">
        {step === "welcome" ? (
          <Welcome key="welcome" onNext={() => setStep("auth")} />
        ) : step === "auth" ? (
          <AuthStep key="auth" onNext={() => setStep("handle")} onBack={() => setStep("welcome")} />
        ) : (
          <HandleStep key="handle" onDone={onDone} onBack={() => setStep("auth")} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Pane({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  return (
    <motion.div
      className="relative flex flex-1 flex-col px-7 pb-10 pt-16 min-h-0 overflow-y-auto no-scrollbar"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      {onBack ? (
        <button
          onClick={onBack}
          aria-label="Back"
          data-testid="onboarding-back"
          className="absolute left-5 top-6 flex h-9 w-9 items-center justify-center rounded-full bg-ink/[0.06] text-ink transition outline-none hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ArrowLeft size={18} />
        </button>
      ) : null}
      {children}
    </motion.div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <Pane>
      <div className="my-auto flex flex-col items-center text-center w-full">
        <div className="text-accent">
          <LogoMark size={64} />
        </div>
        <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="font-display mt-6 text-[28px] leading-tight sm:text-[32px]">
          Money you control.
          <br />
          Private by default.
        </motion.h1>
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-3 max-w-[280px] text-[15px] text-muted">
          Send and get paid privately. Only you ever see your money.
        </motion.p>
        <motion.div variants={stagger} initial="hidden" animate="show" className="mt-8 w-full space-y-3">
          {POINTS.map((p) => (
            <motion.div key={p.title} variants={fadeUp} className="flex items-center gap-3 rounded-2xl bg-card p-4 text-left shadow-[var(--shadow-card)]">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent/10 text-accent">{p.icon}</div>
              <div>
                <div className="text-[15px] font-semibold">{p.title}</div>
                <div className="text-[13px] text-muted">{p.body}</div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
      <Button full size="lg" className="mt-6" onClick={onNext} data-testid="onboarding-cta">
        Get started
      </Button>
    </Pane>
  );
}

function AuthStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [busy, setBusy] = useState<"passkey" | "google" | "stored" | "local" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clientId, setClientId] = useState(GOOGLE_CLIENT_ID_FALLBACK);
  const [hasStoredCredential, setHasStoredCredential] = useState(() => !!currentGoogleCredential());
  const [showLocalVerification] = useState(() => isLocalVerificationUi());
  const gbtn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHasStoredCredential(!!currentGoogleCredential());
  }, []);

  async function withPasskey() {
    setBusy("passkey");
    setErr(null);
    try {
      clearGoogleCredential();
      await registerPasskey({ userName: "benzo-wallet", displayName: "Benzo wallet" });
      const account = await loginWithPasskey(); // derive the on-device shielded account
      const minted = await api.deviceAuth(createDeviceAuthProof(account));
      storeGoogleCredential(minted.token);
      onNext();
    } catch (e) {
      setErr((e as Error).message.includes("cancel") ? "Passkey cancelled." : "Passkey didn't work here. Try again on this device.");
      setBusy(null);
    }
  }

  async function withStoredCredential() {
    setBusy("stored");
    setErr(null);
    try {
      await api.session();
      onNext();
    } catch (e) {
      setErr(friendlyError(e, "Sign in again to continue."));
      setBusy(null);
    }
  }

  async function withLocalVerification() {
    setBusy("local");
    setErr(null);
    try {
      const minted = await api.localVerificationAuth(localVerificationSubject());
      storeGoogleCredential(minted.token);
      onNext();
    } catch (e) {
      setErr(friendlyError(e, "Local verification sign-in is not available in this runtime."));
      setBusy(null);
    }
  }

  // Real Google sign-in (Google Identity Services). Only mounted when a client id is
  // configured; advances ONLY when Google returns a real credential. No placeholder success.
  useEffect(() => {
    let cancelled = false;
    void api.authConfig().then((cfg) => {
      if (!cancelled && cfg.googleClientId) setClientId(cfg.googleClientId);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!clientId || !gbtn.current) return;
    let cancelled = false;
    const init = () => {
      const g = window.google?.accounts?.id;
      if (!g || cancelled || !gbtn.current) return;
      gbtn.current.innerHTML = "";
      g.initialize({
        client_id: clientId,
        callback: async (resp: { credential?: string }) => {
          if (!resp?.credential) {
            setErr("Google sign-in didn't complete. Try again or use your device passkey.");
            return;
          }
          setBusy("google");
          const v = await api.googleVerify(resp.credential).catch((e) => ({ verified: false, error: (e as Error).message }));
          if (v.verified) {
            storeGoogleCredential(resp.credential);
            onNext();
          } else {
            setErr(v.error || "Google sign-in failed.");
            setBusy(null);
          }
        },
      });
      g.renderButton(gbtn.current, {
        theme: "outline",
        size: "large",
        width: 320,
        text: "continue_with",
        shape: "pill",
        logo_alignment: "left",
      });
    };
    if (window.google?.accounts?.id) { init(); return () => { cancelled = true; }; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true; s.onload = init;
    document.head.appendChild(s);
    return () => { cancelled = true; };
  }, [clientId, onNext]);

  return (
    <Pane onBack={onBack}>
      <div className="my-auto flex flex-col items-center text-center w-full pb-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-accent">
          <Fingerprint size={30} />
        </div>
        <h1 className="font-display mt-5 text-[24px] leading-tight sm:text-[26px]">Your keys, your phone</h1>
        <p className="mt-2 max-w-[290px] text-[14px] text-muted">
          Created on this device, unlocked by your passkey, PIN, or security key. We never see your keys or your balance.
        </p>
        {err ? <p className="mt-3 max-w-[290px] text-[13px] text-[#9a6b12]">{err}</p> : null}
      </div>
      <div className="space-y-3">
        <Button full size="lg" onClick={withPasskey} loading={busy === "passkey"} data-testid="auth-passkey">
          <Fingerprint size={18} /> {isWebAuthnAvailable() ? "Continue with passkey" : "Continue with this device"}
        </Button>
        {hasStoredCredential ? (
          <Button full variant="secondary" size="lg" onClick={withStoredCredential} loading={busy === "stored"} data-testid="auth-stored">
            Continue with signed-in account
          </Button>
        ) : null}
        {showLocalVerification ? (
          <Button full variant="secondary" size="lg" onClick={withLocalVerification} loading={busy === "local"} data-testid="auth-local-verification">
            <ShieldCheck size={18} /> Use local verification account
          </Button>
        ) : null}
        {clientId ? (
          <div className="benzo-google-shell flex h-14 w-full items-center justify-center overflow-hidden rounded-full border border-hair bg-card shadow-[0_6px_18px_rgba(25,40,55,0.05)]">
            <div ref={gbtn} className="benzo-google-button flex w-full justify-center" data-testid="auth-google" />
          </div>
        ) : null}
        <p className="pt-1 text-center text-[12px] text-muted">
          No seed phrase. No passwords. Your wallet key is derived on this device.
        </p>
      </div>
    </Pane>
  );
}

function HandleStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const { refresh } = useWallet();
  const [handle, setHandle] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "available" | "taken" | "invalid" | "error">("idle");
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const clean = handle.trim().replace(/^@/, "").toLowerCase();

  useEffect(() => {
    if (!clean) return setState("idle");
    if (!/^[a-z0-9_.]{3,20}$/.test(clean)) return setState("invalid");
    setState("checking");
    let live = true;
    const t = setTimeout(async () => {
      try {
        const { available } = await api.handleAvailable(clean);
        if (live) setState(available ? "available" : "taken");
      } catch {
        // A failed check is NOT "available" - say so honestly so we don't push the
        // user toward a name we couldn't verify (claim re-checks server-side anyway).
        if (live) setState("error");
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [clean]);

  async function claim() {
    if (state !== "available") return;
    setClaiming(true);
    setClaimErr(null);
    try {
      await api.claimHandle(clean);
      await refresh();
      onDone();
    } catch (e) {
      // Only a real "taken" (409 / "taken") should dead-end on this name. Anything
      // else (network/500) is retryable - don't lie that a free handle is taken.
      const m = e instanceof Error ? e.message : "";
      if (/taken|already|409|conflict|exists/i.test(m)) setState("taken");
      else setClaimErr(friendlyError(e, "Couldn't claim that handle - please try again."));
      setClaiming(false);
    }
  }

  return (
    <Pane onBack={onBack}>
      <div className="my-auto flex flex-col w-full pb-6">
        <h1 className="font-display text-[26px] leading-tight">Pick your handle</h1>
        <p className="mt-2 text-[14px] text-muted">A username for money. It's how people pay you.</p>

        <div className="mt-7">
          <div className="flex items-center gap-2 rounded-2xl border border-hair bg-canvas/60 px-4 py-3 transition focus-within:border-accent focus-within:bg-card focus-within:ring-4 focus-within:ring-accent/15">
            <span className="font-display text-xl text-muted">@</span>
            <input
              autoFocus
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="yourname"
              maxLength={20}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Choose a handle"
              data-testid="handle-input"
              className="w-full bg-transparent text-lg text-ink outline-none placeholder:text-ink/30"
            />
            <StatusGlyph state={state} />
          </div>
          <div className="mt-2 flex min-h-[18px] items-center justify-between gap-2 text-[13px]" data-testid="handle-status">
            <span>
              {state === "available" ? <span className="text-pos">@{clean} is available</span> : null}
              {state === "taken" ? <span className="text-danger">@{clean} is taken. Try another.</span> : null}
              {state === "invalid" ? <span className="text-muted">Letters, numbers, dots. 3 to 20 characters.</span> : null}
              {state === "checking" ? <span className="text-muted">Checking…</span> : null}
              {state === "error" ? <span className="text-[#9a6b12]">Couldn't check that handle. Check your connection and try again.</span> : null}
              {claimErr ? <span className="text-danger">{claimErr}</span> : null}
            </span>
            {clean ? <span className="flex-none tabular-nums text-muted" data-testid="handle-counter">{clean.length}/20</span> : null}
          </div>
        </div>
      </div>

      <Button full size="lg" disabled={state !== "available"} loading={claiming} onClick={claim} data-testid="handle-claim">
        {state === "available" ? `Claim @${clean}` : "Claim handle"}
      </Button>
    </Pane>
  );
}

function StatusGlyph({ state }: { state: "idle" | "checking" | "available" | "taken" | "invalid" | "error" }) {
  if (state === "checking") return <Loader2 size={18} className="animate-spin text-muted" />;
  if (state === "available") return <Check size={18} className="text-pos" />;
  if (state === "taken" || state === "invalid") return <X size={18} className="text-danger" />;
  if (state === "error") return <X size={18} className="text-[#9a6b12]" />;
  return null;
}
