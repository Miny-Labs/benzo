/**
 * Profile — who you are, the proof-of-balance entry point, and the few honest
 * settings (mask balance, live mode, where proofs run). Calm, not a crypto
 * settings dump.
 */
import { useEffect, useState } from "react";
import { Activity, BadgeCheck, ChevronRight, Eye, EyeOff, Lock, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../lib/store";
import { getChainStatus } from "../lib/chain";
import { NETWORK_LABEL } from "../lib/network";
import { getLockSettings, setLockSettings, lockCapable, requireUnlock } from "../lib/lock";
import { tierInfo, sendCapUsd } from "../lib/tiers";
import { Screen, Stagger } from "../ui/motion";
import { Avatar, Card } from "../ui/primitives";

export function Profile() {
  const nav = useNavigate();
  const { session, hidden, toggleHidden } = useWallet();
  const live = session?.live;
  const tee = session?.prover.tee;

  // Read the chain's latest ledger DIRECTLY from the browser (no BFF) — the
  // first real "blockchain is the backend" data path. Degrades silently.
  const [ledger, setLedger] = useState<number | null>(null);
  // App lock (C4 — Cash App Security Lock parity): two device-local toggles,
  // gated by the on-device passkey. Disabled when no authenticator exists.
  const lockable = lockCapable();
  const [lock, setLock] = useState(() => getLockSettings());
  const tier = tierInfo(session?.kycTier);
  const [verifyOpen, setVerifyOpen] = useState(false);
  async function toggleLock(key: "onOpen" | "onSend") {
    const next = { ...lock, [key]: !lock[key] };
    // Turning a lock ON requires proving the biometric works right now.
    if (next[key] && !(await requireUnlock())) return;
    setLock(next);
    setLockSettings(next);
  }
  useEffect(() => {
    const ac = new AbortController();
    const tick = () => getChainStatus(ac.signal).then((s) => setLedger(s.sequence)).catch(() => {});
    tick();
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) tick();
    }, 20_000);
    return () => {
      ac.abort();
      clearInterval(iv);
    };
  }, []);

  return (
    <Screen>
      <div className="px-5 pb-2 pt-6">
        <h1 className="font-display text-2xl">Profile</h1>
      </div>
      <Stagger className="space-y-4 px-5">
        <Stagger.Item index={0}>
          <Card className="flex items-center gap-3 p-5">
            <Avatar name={session?.profile.name ?? "You"} tone="accent" size={52} />
            <div>
              <div className="font-display text-lg">{session?.profile.name ?? "You"}</div>
              <div className="text-sm text-muted">{session?.profile.handle ?? "@you"}</div>
            </div>
          </Card>
        </Stagger.Item>

        {/* Proof of balance */}
        <Stagger.Item index={1}>
          <Card onClick={() => nav("/share-proof")} className="flex items-center gap-3 p-4 transition hover:shadow-[0_10px_30px_rgba(115,66,226,0.12)]" >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-pos/12 text-pos"><ShieldCheck size={20} /></div>
            <div className="flex-1">
              <div className="text-[15px] font-semibold">Prove your balance</div>
              <div className="text-[13px] text-muted">Show you hold enough. Never the amount.</div>
            </div>
            <ChevronRight size={18} className="text-muted" />
          </Card>
        </Stagger.Item>

        {/* Verification tier (C5) — the ZK assurance level, never the documents */}
        <Stagger.Item index={2}>
          <Card className="px-4" data-testid="verify-card">
            <div className="flex items-center gap-3 py-3.5">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-pos/12 text-pos"><BadgeCheck size={20} /></div>
              <div className="flex-1">
                <div className="text-[15px] font-semibold" data-testid="tier-label">{tier.label}</div>
                <div className="text-[13px] text-muted">Send up to ${sendCapUsd(session?.kycTier).toLocaleString()} / 30 days · receiving is always unlimited and private</div>
              </div>
            </div>
            {tier.cta ? (
              <div className="border-t border-hair">
                <button onClick={() => setVerifyOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-lg py-3.5 text-left text-[14px] font-semibold text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="verify-cta">
                  <span className="flex-1">{tier.cta}</span>
                  <ChevronRight size={18} className={`text-muted transition ${verifyOpen ? "rotate-90" : ""}`} />
                </button>
                {verifyOpen ? (
                  <p className="pb-3.5 text-[12.5px] leading-relaxed text-muted" data-testid="verify-explainer">
                    A one-time ID check (through a verification provider) raises your private send limit. Your ID never goes on-chain, and the network only learns that you cleared the tier, never who you are.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>
        </Stagger.Item>

        {/* Contacts (C6) */}
        <Stagger.Item index={3}>
          <Card onClick={() => nav("/contacts")} className="flex items-center gap-3 p-4 transition hover:shadow-[0_10px_30px_rgba(115,66,226,0.12)]" data-testid="profile-contacts">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent"><Users size={20} /></div>
            <div className="flex-1">
              <div className="text-[15px] font-semibold">Contacts</div>
              <div className="text-[13px] text-muted">Save people you pay often.</div>
            </div>
            <ChevronRight size={18} className="text-muted" />
          </Card>
        </Stagger.Item>

        {/* Settings */}
        <Stagger.Item index={4}>
          <Card className="divide-y divide-hair px-4">
            <Row
              icon={hidden ? <EyeOff size={18} /> : <Eye size={18} />}
              label="Hide balance"
              right={
                <button
                  onClick={toggleHidden}
                  role="switch"
                  aria-checked={hidden}
                  data-testid="profile-hide-toggle"
                  className={`relative h-6 w-11 rounded-full transition outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card ${hidden ? "bg-accent" : "bg-ink/15"}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${hidden ? "left-[22px]" : "left-0.5"}`} />
                </button>
              }
            />
            <Row
              icon={<Sparkles size={18} />}
              label="Mode"
              right={<span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${live ? "bg-pos/12 text-pos" : "bg-amber/12 text-[#9a6b12]"}`} data-testid="profile-mode">{live ? `Live · ${NETWORK_LABEL.replace(/^Stellar ?/, "") || "Mainnet"}` : "Chain unavailable"}</span>}
            />
            <Row
              icon={<ShieldCheck size={18} />}
              label="Proofs run"
              right={<span className="text-[13px] text-muted">{tee ? "On device or secure enclave" : "On this device"}</span>}
            />
            <Row
              icon={<Activity size={18} />}
              label="Network"
              right={
                <span className="inline-flex items-center gap-1.5 text-[13px] text-muted" data-testid="profile-network" title="Read directly from the chain in your browser — no server">
                  {ledger != null ? (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-pos" />
                      Live · ledger #{ledger.toLocaleString()}
                    </>
                  ) : (
                    "Connecting…"
                  )}
                </span>
              }
            />
          </Card>
        </Stagger.Item>

        {/* Security Lock (C4) */}
        <Stagger.Item index={5}>
          <Card className="px-4" data-testid="security-lock-card">
            <div className="flex items-center gap-3 py-3.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink"><Lock size={18} /></div>
              <div className="flex-1">
                <div className="text-[15px] font-medium">Security Lock</div>
                <div className="text-[12.5px] text-muted">
                  {lockable ? "Use Face ID or your fingerprint" : "Set up a passkey first to enable"}
                </div>
              </div>
            </div>
            <div className="divide-y divide-hair border-t border-hair">
              <LockToggle label="Require to open the app" on={lock.onOpen} disabled={!lockable} onToggle={() => toggleLock("onOpen")} testid="lock-open-toggle" />
              <LockToggle label="Require before each payment" on={lock.onSend} disabled={!lockable} onToggle={() => toggleLock("onSend")} testid="lock-send-toggle" />
            </div>
          </Card>
        </Stagger.Item>

        <Stagger.Item index={6}>
          <p className="px-2 text-center text-[12px] leading-relaxed text-muted">
            Your balance and payments are private by default. Only you can see them, and you choose what to prove.
          </p>
        </Stagger.Item>
      </Stagger>
    </Screen>
  );
}

function LockToggle({ label, on, disabled, onToggle, testid }: { label: string; on: boolean; disabled?: boolean; onToggle: () => void; testid: string }) {
  return (
    <div className={`flex items-center gap-3 py-3.5 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex-1 text-[14px] font-medium">{label}</div>
      <button
        onClick={disabled ? undefined : onToggle}
        role="switch"
        aria-checked={on}
        aria-disabled={disabled}
        disabled={disabled}
        data-testid={testid}
        className={`relative h-6 w-11 rounded-full transition outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card ${on ? "bg-accent" : "bg-ink/15"} ${disabled ? "cursor-not-allowed" : ""}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

function Row({ icon, label, right }: { icon: React.ReactNode; label: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink">{icon}</div>
      <div className="flex-1 text-[15px] font-medium">{label}</div>
      {right}
    </div>
  );
}
