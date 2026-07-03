import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Lock, Fingerprint, KeyRound } from "lucide-react";
import { Input, Button } from "./primitives";
import { unlockWallet, unlockWalletWithPasskey } from "../lib/localWallet";

export function LockGate({ onUnlock }: { onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [walletType, setWalletType] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const type = localStorage.getItem("benzo.wallet.type");
    setWalletType(type || "passkey");
  }, []);

  async function unlockWithPasskey() {
    setBusy(true);
    setFailed(false);
    setErrorMsg(null);
    try {
      await unlockWalletWithPasskey();
      onUnlock();
    } catch (e) {
      setFailed(true);
      setErrorMsg((e as Error).message.includes("cancel") ? "Unlock cancelled." : "Could not unlock with passkey.");
    } finally {
      setBusy(false);
    }
  }

  async function unlockWithPassphrase() {
    if (!passphrase) return;
    setBusy(true);
    setFailed(false);
    setErrorMsg(null);
    try {
      await unlockWallet(passphrase);
      onUnlock();
    } catch (e) {
      setFailed(true);
      setErrorMsg("Incorrect passcode.");
    } finally {
      setBusy(false);
    }
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

      <div className="px-8 text-center w-full max-w-[280px]">
        <h2 className="font-display text-xl">Benzo is locked</h2>
        <p className="mt-1.5 text-[14px] text-muted">
          {walletType === "passphrase"
            ? "Enter your passcode to unlock your wallet."
            : "Unlock with your device passkey to continue."}
        </p>
        {failed && errorMsg ? (
          <p className="mt-2 text-[13px] text-danger" data-testid="lock-failed">
            {errorMsg}
          </p>
        ) : null}
      </div>

      {walletType === "passphrase" ? (
        <div className="w-full max-w-[280px] space-y-4 px-4">
          <Input
            type="password"
            placeholder="Enter passcode"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlockWithPassphrase()}
            data-testid="lock-passcode-input"
            autoFocus
          />
          <Button
            full
            onClick={unlockWithPassphrase}
            disabled={busy || !passphrase}
            data-testid="lock-unlock-passcode"
          >
            <KeyRound size={18} />
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </div>
      ) : (
        <button
          onClick={unlockWithPasskey}
          disabled={busy}
          data-testid="lock-unlock"
          className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-semibold text-white shadow-[var(--shadow-glow)] transition outline-none active:scale-95 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:opacity-60"
        >
          <Fingerprint size={18} />
          {busy ? "Verifying…" : "Unlock"}
        </button>
      )}
    </motion.div>
  );
}
