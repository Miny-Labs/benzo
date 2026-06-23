/**
 * Business onboarding (P0-B1) — the "same caliber as consumer" front door for the
 * console: SSO sign-in → a resumable KYB wizard → register the org's treasury
 * keys on-chain → land in the workspace. KYB is a LABELED mock of a real provider
 * integration (Persona/Sumsub-style hosted flow + decision); the member MVK
 * registration is a GENUINE on-chain tx when live (no ZK is mocked).
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BadgeCheck, Building2, Check, FileCheck2, Landmark, Loader2, ScanSearch, ShieldCheck, Sparkles, Users, Wallet } from "lucide-react";
import { api, type OnboardingDraft } from "../lib/api";
import { friendlyError } from "../lib/format";
import { Logo } from "../ui/Logo";
import { StageVideo } from "../ui/StageVideo";
import { EASE } from "../ui/motion";
import { Button, Card, Pill } from "../ui/primitives";
import { Field, Input, Select, useToast } from "../ui/controls";

// Team is intentionally NOT a step: it collected nothing and gated nothing (a
// pure read-only placeholder). Its one piece of guidance — "invite an approver,
// maker-checker needs proposer ≠ approver" — now lives on the Review step and is
// carried into the workspace as a first-run checklist item, so it surfaces where
// the user can act on it instead of as an inert ceremony step.
const STEPS = [
  { key: "org", label: "Business", icon: Building2 },
  { key: "kyb", label: "Verification (KYB)", icon: FileCheck2 },
  { key: "zone", label: "Compliance", icon: ShieldCheck },
  { key: "treasury", label: "Treasury keys", icon: Wallet },
  { key: "review", label: "Review", icon: Sparkles },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [authed, setAuthed] = useState(false);
  return authed ? <Wizard onDone={onDone} /> : <AuthShell onAuthed={() => setAuthed(true)} />;
}

// ----------------------------------------------------------------- auth / SSO
// zkLogin sign-in. When a Google OAuth client id is configured (BFF GOOGLE_CLIENT_ID,
// surfaced via /api/auth/config), this renders the REAL Google Identity Services
// button: the browser gets a genuine Google ID token (JWT), the BFF verifies its
// RS256 signature against Google's JWKs (see google-oidc.ts), and the Benzo account
// is derived from the verified `sub` (accountFromOidc) — the Sui-zkLogin model
// (Phase 1; the in-circuit JWT proof is Phase 2, docs/ZKLOGIN.md). When no client
// id is set, it falls back to a clearly-labeled DEMO sign-in.
declare global {
  interface Window { google?: any }
}
function AuthShell({ onAuthed }: { onAuthed: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const gbtn = useRef<HTMLDivElement>(null);

  // Load real Google Identity Services if the BFF has a client id configured.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await api.authConfig().catch(() => ({ googleClientId: null }) as { googleClientId: string | null });
      if (cancelled || !cfg.googleClientId) return;
      setClientId(cfg.googleClientId);
      const init = () => {
        const g = window.google?.accounts?.id;
        if (!g || !gbtn.current) return;
        g.initialize({
          client_id: cfg.googleClientId,
          callback: async (resp: { credential: string }) => {
            setBusy("google");
            const v = await api.googleVerify(resp.credential).catch((e) => ({ verified: false, error: (e as Error).message }));
            if (v.verified) onAuthed();
            else { setErr(v.error || "Google sign-in failed"); setBusy(null); }
          },
        });
        g.renderButton(gbtn.current, { theme: "outline", size: "large", width: 356, text: "continue_with" });
      };
      if (window.google?.accounts?.id) { init(); return; }
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true; s.onload = init;
      document.head.appendChild(s);
    })();
    return () => { cancelled = true; };
  }, [onAuthed]);

  function demoSso(provider: string) {
    // When a real Google client id is configured, never silently advance through a
    // demo button — that would let someone bypass the real OIDC sign-in. Tell them
    // to use the live Google button instead.
    if (clientId) {
      setErr("Use the Google button above to sign in. Other providers aren't enabled for this workspace yet.");
      return;
    }
    setBusy(provider);
    // DEMO sign-in (used only when no GOOGLE_CLIENT_ID is configured). No OAuth;
    // advances to setup. The genuinely real, on-chain step is the treasury-key
    // (MVK) registration + the in-circuit M-of-N that gates every spend.
    setTimeout(onAuthed, 350);
  }
  return (
    <Centered>
      <Card className="w-[420px] p-8 text-center">
        <div className="mx-auto mb-5 flex items-center justify-center gap-2 text-ink">
          <Logo size={26} /> <span className="font-display text-xl">Benzo for Business</span>
        </div>
        <h1 className="font-display text-2xl">Pay your team privately</h1>
        <p className="mt-1.5 text-[13.5px] text-muted">Run payroll and pay vendors on-chain. Amounts and recipients stay confidential by default.</p>
        <div className="mt-6 space-y-2.5">
          {clientId ? (
            // Real Google sign-in (zkLogin Phase 1).
            <div ref={gbtn} className="flex justify-center" data-testid="auth-google" />
          ) : (
            <Button className="w-full" size="md" loading={busy === "google"} onClick={() => demoSso("google")} data-testid="auth-google">
              Continue with Google (demo)
            </Button>
          )}
          <Button className="w-full" size="md" variant="outline" disabled={!!clientId} loading={busy === "microsoft"} onClick={() => demoSso("microsoft")} data-testid="auth-microsoft" title={clientId ? "Microsoft SSO isn't enabled for this workspace yet" : undefined}>
            Continue with Microsoft{clientId ? "" : " (demo)"}
          </Button>
          <a
            href="mailto:sales@benzo.app?subject=Benzo%20for%20Business%20%E2%80%94%20SSO%20setup"
            className="block w-full rounded-[10px] border border-border py-2.5 text-center text-[13px] font-medium text-muted transition hover:bg-[#f4f3ef]"
          >
            Need Okta or SAML? Contact us
          </a>
        </div>
        {err ? <p className="mt-3 text-[12px] text-danger">{err}</p> : null}
        <p className="mt-5 text-[11.5px] text-muted">
          {clientId
            ? "Real Google sign-in (zkLogin): the JWT is verified against Google's keys, and your account is derived from it on-chain — your Google identity never goes on-chain."
            : "Demo sign-in (set GOOGLE_CLIENT_ID to enable real Google zkLogin). Your treasury keys are generated on this device in the next step — we never see your balances."}
        </p>
      </Card>
    </Centered>
  );
}

// ----------------------------------------------------------------- wizard
function Wizard({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [stepIdx, setStepIdx] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>({ country: "US", entityType: "C-Corp", complianceZoneId: "zone_us" });
  const [kyb, setKyb] = useState<OnboardingDraft["kyb"] | null>(null);
  const [mvk, setMvk] = useState<OnboardingDraft["mvk"] | null>(null);
  const [busy, setBusy] = useState(false);
  const step = STEPS[stepIdx];
  const set = (p: Partial<OnboardingDraft>) => setDraft((d) => ({ ...d, ...p }));

  const canNext =
    step.key === "org" ? !!draft.name && !!draft.legalName :
    step.key === "kyb" ? kyb?.status === "approved" :
    step.key === "treasury" ? !!mvk :
    true;

  async function next() {
    if (stepIdx < STEPS.length - 1) {
      // persist draft as we go (resumable) — if the save fails, let them keep going
      // but warn so they know progress might not be picked up if they reload.
      void api.saveOnboarding(draft).catch(() =>
        toast({ title: "Couldn't save your progress — you can keep going, but it may not resume if you reload.", tone: "danger" }),
      );
      setStepIdx((i) => i + 1);
    } else {
      setBusy(true);
      try {
        await api.finishOnboarding();
        onDone();
      } catch (e) {
        toast({ title: friendlyError(e), tone: "danger" });
        setBusy(false);
      }
    }
  }

  async function registerMvk() {
    setBusy(true);
    try {
      const r = await api.registerOwnerMvk();
      setMvk(r);
      toast({ title: r.onChain ? "Your secure books are ready" : "Set up (demo)", tone: "success" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered wide>
      <Card className="flex w-[760px] overflow-hidden p-0">
        {/* step rail */}
        <div className="w-[230px] flex-none border-r border-border bg-surface p-5">
          <div className="mb-5 flex items-center gap-2 text-ink"><Logo size={20} /> <span className="font-display">Benzo</span></div>
          <div className="space-y-1">
            {STEPS.map((s, i) => {
              const done = i < stepIdx;
              const cur = i === stepIdx;
              return (
                <div key={s.key} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] ${cur ? "bg-primary/[0.07] font-semibold text-primary" : done ? "text-ink" : "text-muted"}`}>
                  <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] ${done ? "bg-success/15 text-[#1d7a52]" : cur ? "bg-primary text-white" : "bg-border/60 text-muted"}`}>
                    {done ? <Check size={12} /> : i + 1}
                  </span>
                  {s.label}
                </div>
              );
            })}
          </div>
        </div>

        {/* step content */}
        <div className="flex flex-1 flex-col p-7">
          <AnimatePresence mode="wait">
            <motion.div key={step.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: EASE }} className="flex-1">
              {step.key === "org" ? (
                <Step title="About your business" hint="The legal entity that will hold the treasury.">
                  <Field label="Business name"><Input value={draft.name ?? ""} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Acme Robotics" data-testid="org-name" /></Field>
                  <Field label="Legal name"><Input value={draft.legalName ?? ""} maxLength={80} onChange={(e) => set({ legalName: e.target.value })} placeholder="Acme Robotics Inc." data-testid="org-legal" /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Select label="Country" value={draft.country} onChange={(e) => set({ country: e.target.value })}>
                      <option value="US">United States</option><option value="GB">United Kingdom</option><option value="DE">Germany</option><option value="SG">Singapore</option>
                    </Select>
                    <Select label="Entity type" value={draft.entityType} onChange={(e) => set({ entityType: e.target.value })}>
                      <option>C-Corp</option><option>LLC</option><option>Ltd</option><option>GmbH</option>
                    </Select>
                  </div>
                </Step>
              ) : step.key === "kyb" ? (
                <Step title="Verify your business (KYB)" hint="Business registration + beneficial-owner screening. The decision is recorded on-chain, not in a backend.">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Registration #"><Input value={draft.registrationNumber ?? ""} onChange={(e) => set({ registrationNumber: e.target.value })} placeholder="C1234567" disabled={kyb?.status === "approved"} /></Field>
                    <Field label="Tax ID (EIN)"><Input value={draft.taxId ?? ""} onChange={(e) => set({ taxId: e.target.value })} placeholder="88-1234567" disabled={kyb?.status === "approved"} /></Field>
                  </div>
                  <KybVerify draft={draft} kyb={kyb} onVerified={setKyb} onError={(m) => toast({ title: m, tone: "danger" })} />
                </Step>
              ) : step.key === "zone" ? (
                <Step title="Where money can move" hint="Pick the regions you operate in. We only let funds move to approved, compliant destinations.">
                  {[{ id: "zone_us", name: "United States", j: "US" }, { id: "zone_eu", name: "European Union", j: "EU" }].map((z) => (
                    <button key={z.id} onClick={() => set({ complianceZoneId: z.id })} className={`flex w-full items-center justify-between rounded-xl border p-4 text-left transition ${draft.complianceZoneId === z.id ? "border-primary bg-primary/[0.05]" : "border-border hover:bg-[#f4f3ef]"}`}>
                      <span className="font-semibold">{z.name}</span>
                      <span className={`h-4 w-4 rounded-full border-2 ${draft.complianceZoneId === z.id ? "border-primary bg-primary" : "border-border"}`} />
                    </button>
                  ))}
                </Step>
              ) : step.key === "treasury" ? (
                <Step title="Set up your secure books" hint="This creates the keys that let only your team read your books and prove balances to auditors. It's the one step we can't skip.">
                  {mvk ? (
                    <div className="rounded-xl border border-success/25 bg-success/[0.06] p-4" data-testid="mvk-result">
                      <div className="flex items-center gap-2 text-[14px] font-semibold text-[#1d7a52]"><Check size={16} /> Your secure books are ready{mvk.onChain ? "" : " (demo)"}</div>
                      {mvk.txHash ? <div className="mt-1 break-all font-mono text-[11px] text-muted">ref {mvk.txHash}</div> : null}
                    </div>
                  ) : (
                    <Button loading={busy} onClick={registerMvk} data-testid="mvk-register"><ShieldCheck size={16} /> Set up keys</Button>
                  )}
                </Step>
              ) : (
                <Step title="You're all set" hint="Review and enter your workspace.">
                  <div className="space-y-2 rounded-xl border border-border p-4 text-[13.5px]">
                    <Row k="Business" v={draft.name ?? "Not set"} />
                    <Row k="Legal" v={draft.legalName ?? "Not set"} />
                    <Row k="Country" v={draft.country ?? "Not set"} />
                    <Row k="KYB" v={kyb?.status === "approved" ? (kyb.onChain ? "Verified on-chain" : "Verified") : "Pending"} />
                    <Row k="Compliance" v={draft.complianceZoneId === "zone_eu" ? "European Union" : "United States"} />
                    <Row k="Secure books" v={mvk?.onChain ? "Ready" : mvk ? "Demo" : "Not set up"} />
                  </div>
                  <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-border p-3.5 text-[12.5px] text-muted">
                    <Users size={15} className="mt-px flex-none text-primary" />
                    <span>Next, fund your treasury and invite an approver from <b>Settings → Team</b> — maker-checker needs a proposer ≠ approver before your first payout. We'll keep this checklist in your workspace.</span>
                  </div>
                </Step>
              )}
            </motion.div>
          </AnimatePresence>

          <div className="mt-6 flex items-center justify-between">
            <button onClick={() => setStepIdx((i) => Math.max(0, i - 1))} disabled={stepIdx === 0} className="text-[13px] font-semibold text-muted disabled:opacity-40">Back</button>
            <Button onClick={next} disabled={!canNext} loading={busy && stepIdx === STEPS.length - 1} data-testid={stepIdx === STEPS.length - 1 ? "onboarding-finish" : "wizard-next"}>
              {stepIdx === STEPS.length - 1 ? "Enter workspace" : "Continue"}
            </Button>
          </div>
        </div>
      </Card>
    </Centered>
  );
}

// ----------------------------------------------------------------- KYB (on-chain)
// The crafted verification moment. The checks animate while the REAL on-chain
// attestation is posted (org_account, issuer-signed); the verified panel reflects
// the on-chain decision read back from chain. Honest: no backend flag, a real tx.
const KYB_STEPS = [
  { label: "Business registration", icon: FileCheck2 },
  { label: "Beneficial owners", icon: Users },
  { label: "Sanctions / OFAC screen", icon: ScanSearch },
  { label: "Posting decision on-chain", icon: Landmark },
] as const;

function KybVerify({
  draft, kyb, onVerified, onError,
}: {
  draft: OnboardingDraft;
  kyb: OnboardingDraft["kyb"] | null;
  onVerified: (k: NonNullable<OnboardingDraft["kyb"]>) => void;
  onError: (m: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "verifying" | "done">(kyb?.status === "approved" ? "done" : "idle");
  const [lit, setLit] = useState(0); // how many of the first 3 screening checks have completed

  async function run() {
    setPhase("verifying");
    setLit(0);
    // Play the first three screening checks on a cadence; the 4th (on-chain) stays
    // pending until the real attestation tx resolves.
    const timers = [0, 1, 2].map((i) => setTimeout(() => setLit(i + 1), 650 * (i + 1)));
    try {
      const r = await api.submitKyb(draft);
      timers.forEach(clearTimeout);
      setLit(3);
      if (r.status !== "approved") {
        setPhase("idle");
        onError("Verification did not pass. Please check the details and try again.");
        return;
      }
      onVerified(r);
      // brief beat so the on-chain step visibly completes before the reveal
      setTimeout(() => setPhase("done"), 360);
    } catch {
      timers.forEach(clearTimeout);
      setPhase("idle");
      onError("Couldn't post the verification on-chain. Please try again.");
    }
  }

  if (phase === "done" && kyb?.status === "approved") {
    const ref = kyb.txHash ? `${kyb.txHash.slice(0, 8)}…${kyb.txHash.slice(-6)}` : kyb.inquiryRef;
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}
        className="rounded-xl border border-success/25 bg-success/[0.06] p-4" data-testid="kyb-result"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-success/15 text-[#1d7a52]"><BadgeCheck size={19} /></span>
          <div className="leading-tight">
            <div className="text-[14px] font-semibold text-[#1d7a52]">Verified {kyb.onChain ? "on-chain" : ""}</div>
            <div className="text-[12px] text-muted">{kyb.provider}</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">{kyb.checks.map((c) => <Pill key={c} tone="success">{c.replace(/_/g, " ")}</Pill>)}</div>
        {kyb.onChain ? (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-[#f4f3ef] px-2.5 py-1.5 font-mono text-[11px] text-muted" title="org_account.attest_kyb reference">
            <Landmark size={12} className="text-primary" /> org_account · ref {ref}
          </div>
        ) : null}
        <div className="mt-2 text-[11.5px] text-muted">
          Signed by the KYB issuer key and recorded in <b>org_account</b>. The console reads this decision from the chain, not from a backend flag.
        </div>
      </motion.div>
    );
  }

  if (phase === "verifying") {
    return (
      <div className="rounded-xl border border-border bg-surface p-4" data-testid="kyb-verifying">
        <div className="space-y-2.5">
          {KYB_STEPS.map((s, i) => {
            const isChain = i === 3;
            const done = isChain ? false : i < lit;
            const active = isChain ? lit >= 3 : i === lit;
            return (
              <div key={s.label} className="flex items-center gap-3">
                <motion.span
                  animate={{ scale: done ? 1 : 0.92 }}
                  className={`flex h-6 w-6 flex-none items-center justify-center rounded-full ${done ? "bg-success/15 text-[#1d7a52]" : active ? "bg-primary/10 text-primary" : "bg-border/50 text-muted"}`}
                >
                  {done ? <Check size={13} /> : active ? <Loader2 size={13} className="animate-spin" /> : <s.icon size={12} />}
                </motion.span>
                <span className={`text-[13px] ${done ? "text-ink" : active ? "font-medium text-ink" : "text-muted"}`}>{s.label}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[11.5px] text-muted">Recording the decision in org_account. This is a real transaction and takes a few seconds.</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-border p-4">
      <div className="flex items-center gap-2 text-[13px] text-muted"><ShieldCheck size={15} className="text-primary" /> We screen your registration and owners, then record the decision on-chain.</div>
      <Button variant="outline" className="mt-3" onClick={run} data-testid="kyb-run"><ScanSearch size={15} /> Run verification</Button>
    </div>
  );
}

function Step({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="font-display text-xl">{title}</h2>
      <p className="mt-1 text-[13px] text-muted">{hint}</p>
      <div className="mt-5 space-y-3">{children}</div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3"><span className="flex-none text-muted">{k}</span><span className="min-w-0 truncate font-semibold text-ink" title={v}>{v}</span></div>;
}
function Centered({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-screen w-full items-center justify-center bg-[var(--color-canvas-outer)] p-6" data-testid="console-onboarding">
      {/* looping video stage behind the sign-in card (matches the authenticated Shell) */}
      <StageVideo />
      <div className={`pointer-events-none absolute inset-0 ${wide ? "" : ""} bg-[radial-gradient(50%_40%_at_50%_0%,rgba(115,66,226,0.08),transparent)]`} />
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className="relative z-10">
        {children}
      </motion.div>
    </div>
  );
}
