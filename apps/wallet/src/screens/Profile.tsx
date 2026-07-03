/**
 * Profile - who you are, the proof-of-balance entry point, and the few honest
 * settings (mask balance, live mode, where proofs run). Calm, not a crypto
 * settings dump.
 */
import { useEffect, useState } from "react";
import { Activity, BadgeCheck, ChevronRight, Eye, EyeOff, KeyRound, Lock, ShieldCheck, Sparkles, Trash2, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../lib/store";
import { api, notifyAuthRequired, type RecoveryStatus } from "../lib/api";
import { getChainStatus } from "../lib/chain";
import { NETWORK_LABEL } from "../lib/network";
import { getLockSettings, setLockSettings, lockCapable, requireUnlock } from "../lib/lock";
import { tierInfo, sendCapUsd } from "../lib/tiers";
import { Screen, Stagger } from "../ui/motion";
import { Avatar, Button, Card } from "../ui/primitives";
import { getLocalAccountSummary } from "../lib/localWallet";

export function Profile() {
  const nav = useNavigate();
  const { session, balance, publicBalance, hidden, toggleHidden } = useWallet();
  const live = session?.live;
  const summary = getLocalAccountSummary();
  const displayHandle = summary?.address ? `${summary.address.slice(0, 8)}…${summary.address.slice(-8)}` : "Local Wallet";

  // Read the chain's latest ledger DIRECTLY from the browser (no BFF) - the
  // first real "blockchain is the backend" data path. Degrades silently.
  const [ledger, setLedger] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus["recovery"] | null>(null);
  // App lock (C4 - Cash App Security Lock parity): two device-local toggles,
  // gated by the on-device passkey. Disabled when no authenticator exists.
  const lockable = lockCapable();
  const [lock, setLock] = useState(() => getLockSettings());
  const tier = tierInfo(session?.kycTier);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const privateHasFunds = BigInt(balance?.stroops ?? "0") > 0n;
  const publicHasFunds = BigInt(publicBalance?.stroops ?? "0") > 0n;
  async function toggleLock(key: "onOpen" | "onSend") {
    const next = { ...lock, [key]: !lock[key] };
    // Turning a lock ON requires proving the platform passkey prompt works right now.
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

  async function deleteAccount() {
    setDeleting(true);
    setDeleteErr(null);
    try {
      await api.deleteAccount();
      notifyAuthRequired();
    } catch (e) {
      setDeleteErr((e as Error).message || "Account could not be deleted yet.");
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    api.recoveryStatus()
      .then((r) => {
        if (!cancelled) setRecovery(r.recovery);
      })
      .catch(() => {
        if (!cancelled) setRecovery(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Screen>
      <div className="px-5 pb-2 pt-6">
        <h1 className="font-display text-2xl">Profile</h1>
      </div>
      <Stagger className="space-y-4 px-5 pb-28">
        <Stagger.Item index={0}>
          <Card className="flex items-center gap-3 p-5">
            <Avatar name={session?.profile.name ?? "You"} tone="accent" size={52} />
            <div>
              <div className="font-display text-lg">{session?.profile.name ?? "You"}</div>
              <div className="text-sm text-muted">{displayHandle}</div>
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

        {/* Verification tier (C5) - the ZK assurance level, never the documents */}
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
              right={<span className="text-[13px] text-muted">Local only</span>}
            />
            <Row
              icon={<KeyRound size={18} />}
              label="Account recovery"
              right={
                <span className="text-right text-[13px] text-muted" data-testid="profile-recovery-status">
                  {recovery?.bound ? "Bound to this sign-in" : "Not bound yet"}
                </span>
              }
            />
            <Row
              icon={<KeyRound size={18} />}
              label="Recovery path"
              right={
                <span className="max-w-[180px] text-right text-[12.5px] leading-tight text-muted" data-testid="profile-recovery-plan">
                  {recovery?.nextSteps?.[0] ?? "Sign in to bind this wallet."}
                </span>
              }
            />
            <Row
              icon={<Activity size={18} />}
              label="Network"
              right={
                <span className="inline-flex items-center gap-1.5 text-[13px] text-muted" data-testid="profile-network" title="Read directly from the chain in your browser - no server">
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
                  {lockable ? "Use your device passkey, PIN, or security key" : "Set up a passkey first to enable"}
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
          <Card className="space-y-3 p-4" data-testid="account-freedom-card">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-canvas text-ink"><KeyRound size={18} /></div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold">Your account stays yours</div>
                <div className="mt-1 text-[12.5px] leading-relaxed text-muted">
                  Move money to any Stellar wallet before leaving. Private funds must be made public or cashed out first. Deleting creates a fresh Benzo wallet next time you sign in.
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" onClick={() => nav("/deposit")} data-testid="account-receive">Receive address</Button>
              <Button variant="secondary" size="sm" onClick={() => nav("/send?mode=public")} data-testid="account-send-out">Send out</Button>
              <Button variant="secondary" size="sm" onClick={() => nav("/convert?mode=public")} data-testid="account-make-public">Make public</Button>
              <Button variant="secondary" size="sm" onClick={() => setDeleteOpen((v) => !v)} data-testid="account-delete-open">
                <Trash2 size={14} /> Delete data
              </Button>
            </div>
            {deleteOpen ? (
              <div className="rounded-xl border border-hair bg-canvas/70 p-3" data-testid="account-delete-panel">
                <div className="text-[12.5px] leading-relaxed text-muted">
                  Deletion clears hosted Benzo profile data for this sign-in and rotates your Benzo wallet. It will be refused while any private balance, public balance, or pending invite funds remain.
                </div>
                {(privateHasFunds || publicHasFunds) ? (
                  <div className="mt-2 rounded-lg bg-amber/12 px-3 py-2 text-[12px] font-medium text-[#9a6b12]" data-testid="account-delete-blocked">
                    Move funds out first. Private: {privateHasFunds ? "not empty" : "empty"} · Public: {publicHasFunds ? "not empty" : "empty"}
                  </div>
                ) : null}
                {deleteErr ? <div className="mt-2 text-[12px] font-medium text-danger" data-testid="account-delete-error">{deleteErr}</div> : null}
                <Button full variant="danger" size="sm" className="mt-3" loading={deleting} onClick={deleteAccount} data-testid="account-delete-confirm">
                  Delete hosted data
                </Button>
              </div>
            ) : null}
          </Card>
        </Stagger.Item>

        <Stagger.Item index={7}>
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
