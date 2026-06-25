/**
 * The app-open lock screen (C4). Shown over everything when "require unlock on
 * open" is set, until the on-device passkey / Face ID check passes. Mirrors Cash
 * App's Security Lock: nothing is readable until you authenticate.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { Lock, Fingerprint } from "lucide-react";
import { requireUnlock } from "../lib/lock";

export function LockGate({ onUnlock }: { onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function unlock() {
    setBusy(true);
    setFailed(false);
    const ok = await requireUnlock();
    setBusy(false);
    if (ok) onUnlock();
    else setFailed(true);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-hidden bg-canvas"
      data-testid="lock-gate"
    >
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 240, damping: 18 }}
        className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/12 text-accent"
      >
        <Lock size={34} />
      </motion.div>
      <div className="px-8 text-center">
        <h2 className="font-display text-xl">Benzo is locked</h2>
        <p className="mt-1.5 text-[14px] text-muted">Unlock with Face ID or your fingerprint to continue.</p>
        {failed ? <p className="mt-2 text-[13px] text-danger" data-testid="lock-failed">Couldn't verify. Try again.</p> : null}
      </div>
      <button
        onClick={unlock}
        disabled={busy}
        data-testid="lock-unlock"
        className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-semibold text-white shadow-[var(--shadow-glow)] transition outline-none active:scale-95 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:opacity-60"
      >
        <Fingerprint size={18} />
        {busy ? "Verifying…" : "Unlock"}
      </button>
    </motion.div>
  );
}
