import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Eye, EyeOff, Fingerprint, Key, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { LogoMark } from "../ui/Logo";
import { Button, Input, useToast } from "../ui/primitives";
import { fadeUp, stagger, EASE } from "../ui/motion";
import { useWallet } from "../lib/store";
import { isWebAuthnAvailable } from "../lib/passkey";
import { createWallet, createWalletWithPasskey, importWallet, exportWallet } from "../lib/localWallet";

type Step = "welcome" | "create_lock" | "import" | "backup";

const POINTS = [
  { icon: <ShieldCheck size={18} />, title: "Local custody", body: "Secrets are kept on your device, locked by passkey or passcode." },
  { icon: <KeyRound size={18} />, title: "No hosted accounts", body: "No usernames, no Google logins. Pure self-custody." },
  { icon: <Eye size={18} />, title: "Private by default", body: "Zero-knowledge proofs keep your balances and payouts hidden." },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [importedText, setImportedText] = useState("");
  const [backupText, setBackupText] = useState("");
  const [hasBackedUp, setHasBackedUp] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [lockMethod, setLockMethod] = useState<"passkey" | "passphrase">("passkey");
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const { refresh } = useWallet();

  const isPasskeyCapable = isWebAuthnAvailable();

  useEffect(() => {
    if (!isPasskeyCapable) {
      setLockMethod("passphrase");
    }
  }, [isPasskeyCapable]);

  async function handleCreateWithPasskey() {
    setBusy(true);
    setErr(null);
    try {
      await createWalletWithPasskey("benzo-local-user");
      const backup = await exportWallet();
      setBackupText(backup);
      setStep("backup");
    } catch (e) {
      setErr((e as Error).message.includes("cancel") ? "Passkey cancelled." : "Could not create passkey wallet. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateWithPassphrase() {
    if (passphrase.length < 4) {
      setErr("Passcode must be at least 4 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setErr("Passcodes do not match.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await createWallet(passphrase);
      const backup = await exportWallet();
      setBackupText(backup);
      setStep("backup");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!importedText.trim()) {
      setErr("Please paste your backup JSON or Stellar secret key.");
      return;
    }
    if (lockMethod === "passphrase" && passphrase.length < 4) {
      setErr("Passcode must be at least 4 characters.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (lockMethod === "passphrase") {
        await importWallet(importedText, passphrase);
      } else {
        await importWallet(importedText);
      }
      toast({ title: "Wallet imported successfully!", tone: "success" });
      const backup = await exportWallet();
      setBackupText(backup);
      setStep("backup");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleCopyBackup() {
    navigator.clipboard.writeText(backupText);
    toast({ title: "Backup copied to clipboard!", tone: "success" });
  }

  async function handleFinish() {
    setBusy(true);
    try {
      await refresh();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      className="absolute inset-0 z-[70] flex flex-col bg-canvas"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-testid="onboarding"
    >
      <AnimatePresence mode="wait">
        {step === "welcome" && (
          <Pane key="welcome">
            <div className="my-auto flex flex-col items-center text-center w-full">
              <div className="text-accent">
                <LogoMark size={64} />
              </div>
              <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="font-display mt-6 text-[28px] leading-tight sm:text-[32px]">
                Money you control.
                <br />
                Local & Private.
              </motion.h1>
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-3 max-w-[280px] text-[15px] text-muted">
                A secure, local-first web wallet. Secrets stay on your device.
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
            <div className="mt-6 space-y-3">
              <Button full size="lg" onClick={() => setStep("create_lock")} data-testid="onboarding-create">
                Create new wallet
              </Button>
              <Button full variant="secondary" size="lg" onClick={() => { setStep("import"); setErr(null); }} data-testid="onboarding-import">
                Import existing wallet
              </Button>
            </div>
          </Pane>
        )}

        {step === "create_lock" && (
          <Pane key="create_lock" onBack={() => { setStep("welcome"); setErr(null); }}>
            <div className="my-auto flex flex-col w-full pb-6">
              <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-full bg-accent/10 text-accent">
                <Key size={30} />
              </div>
              <h1 className="font-display mt-5 text-center text-[24px] leading-tight sm:text-[26px]">Secure your wallet</h1>
              <p className="mt-2 text-center text-[14px] text-muted max-w-[290px] mx-auto">
                Select how you want to encrypt and unlock your local wallet keys.
              </p>

              {err ? <p className="mt-4 text-center text-[13px] text-danger" data-testid="onboarding-error">{err}</p> : null}

              {isPasskeyCapable && (
                <div className="mt-6 flex flex-col gap-4">
                  <div className="flex justify-center">
                    <Button full size="lg" onClick={handleCreateWithPasskey} loading={busy} data-testid="create-passkey">
                      <Fingerprint size={18} /> Continue with Passkey
                    </Button>
                  </div>
                  <div className="relative flex py-2 items-center">
                    <div className="flex-grow border-t border-hair"></div>
                    <span className="flex-shrink mx-4 text-muted text-xs">or protect with passcode</span>
                    <div className="flex-grow border-t border-hair"></div>
                  </div>
                </div>
              )}

              <div className="mt-4 space-y-4">
                <Input
                  type="password"
                  label="Choose a passcode"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="At least 4 characters"
                  data-testid="passcode-input"
                />
                <Input
                  type="password"
                  label="Confirm passcode"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Repeat passcode"
                  data-testid="confirm-passcode-input"
                />
                <Button full size="lg" variant="secondary" onClick={handleCreateWithPassphrase} loading={busy} data-testid="create-passcode">
                  Set Passcode
                </Button>
              </div>
            </div>
          </Pane>
        )}

        {step === "import" && (
          <Pane key="import" onBack={() => { setStep("welcome"); setErr(null); }}>
            <div className="my-auto flex flex-col w-full pb-6">
              <h1 className="font-display text-[26px] leading-tight">Import wallet</h1>
              <p className="mt-2 text-[14px] text-muted">Paste your Backup JSON or Stellar private key.</p>

              <div className="mt-4">
                <textarea
                  value={importedText}
                  onChange={(e) => setImportedText(e.target.value)}
                  placeholder='Paste {"stellarSecret": "...", "orgSpendId": "...", "mvkSeedHex": "..."} or a secret key starting with "S"'
                  rows={4}
                  data-testid="import-textarea"
                  className="w-full rounded-2xl border border-hair bg-canvas/60 px-4 py-3 text-[14px] text-ink placeholder:text-muted outline-none transition focus:border-accent focus:bg-card focus:ring-4 focus:ring-accent/15"
                />
              </div>

              {err ? <p className="mt-2 text-[13px] text-danger" data-testid="import-error">{err}</p> : null}

              {isPasskeyCapable && (
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => setLockMethod("passkey")}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-semibold transition ${lockMethod === "passkey" ? "border-accent bg-accent/10 text-accent" : "border-hair text-muted"}`}
                  >
                    Lock with Passkey
                  </button>
                  <button
                    onClick={() => setLockMethod("passphrase")}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-semibold transition ${lockMethod === "passphrase" ? "border-accent bg-accent/10 text-accent" : "border-hair text-muted"}`}
                  >
                    Lock with Passcode
                  </button>
                </div>
              )}

              {lockMethod === "passphrase" && (
                <div className="mt-4">
                  <Input
                    type="password"
                    label="Choose a passcode for this wallet"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="At least 4 characters"
                    data-testid="import-passcode-input"
                  />
                </div>
              )}
            </div>

            <Button full size="lg" onClick={handleImport} loading={busy} data-testid="import-submit">
              Import Wallet
            </Button>
          </Pane>
        )}

        {step === "backup" && (
          <Pane key="backup">
            <div className="my-auto flex flex-col w-full pb-6">
              <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
                <ShieldAlert size={30} />
              </div>
              <h1 className="font-display mt-5 text-center text-[24px] leading-tight">Backup your wallet</h1>
              <p className="mt-2 text-center text-[14px] text-muted max-w-[290px] mx-auto">
                Your keys are stored only in this browser. If you clear your browser data or lose this device, your funds will be lost forever.
              </p>

              <div className="mt-6 p-4 rounded-2xl bg-amber-500/5 border border-amber-500/20 text-[13px] text-amber-700 leading-relaxed">
                Save your backup JSON securely. You can use it to restore your wallet on any other device.
              </div>

              <div className="mt-4 flex flex-col gap-2">
                <Button full variant="secondary" size="md" onClick={() => setShowBackup(!showBackup)}>
                  {showBackup ? <EyeOff size={16} /> : <Eye size={16} />} {showBackup ? "Hide Backup" : "Reveal Backup Data"}
                </Button>

                {showBackup && (
                  <div className="relative mt-2">
                    <pre className="p-3 text-[11px] rounded-xl bg-card border border-hair overflow-x-auto max-h-[150px] text-muted select-all">
                      {backupText}
                    </pre>
                    <button
                      onClick={handleCopyBackup}
                      className="mt-2 text-xs font-semibold text-accent hover:underline focus:outline-none"
                    >
                      Copy Backup Data
                    </button>
                  </div>
                )}
              </div>

              <label className="mt-6 flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hasBackedUp}
                  onChange={(e) => setHasBackedUp(e.target.checked)}
                  data-testid="backup-confirm"
                  className="mt-1 rounded border-hair text-accent focus:ring-accent"
                />
                <span className="text-[13px] text-muted leading-tight">
                  I have saved my backup data securely and understand that Benzo cannot recover it for me.
                </span>
              </label>
            </div>

            <Button full size="lg" disabled={!hasBackedUp} loading={busy} onClick={handleFinish} data-testid="backup-finish">
              Enter Wallet
            </Button>
          </Pane>
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
