/**
 * Receive - your USDC address + QR so ANY wallet or exchange can pay you. What
 * lands here is your PUBLIC balance (plain liquid USDC). No bank, no ramp. The
 * address + QR are public (anyone can pay you here). Optional one-tap "Make
 * private" moves what's landed into your private balance - the same real
 * Groth16/BN254 on-chain op as Add money. Web2-clean: a clear address, a copy
 * button, a "landed" amount, and one button.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import { ArrowDownToLine, Check, Copy, ShieldCheck } from "lucide-react";
import { api, type SettleResult } from "../lib/api";
import { copyTextToClipboard } from "../lib/clipboard";
import { useWallet } from "../lib/store";
import { fmtUsd } from "../lib/format";
import { NETWORK_LABEL, USDC_ASSET } from "../lib/network";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { Button } from "../ui/primitives";
import { PrivateChip } from "../ui/privacy";
import { OnChainDetails } from "../ui/OnChainDetails";
import { getLocalAccountSummary } from "../lib/localWallet";

type Info = { address: string | null; liquid: string; asset: string; issuer: string; live: boolean };
type Phase = "show" | "busy" | "done";

export function Deposit() {
  const { refresh } = useWallet();
  const [info, setInfo] = useState<Info | null>(null);
  const [infoErr, setInfoErr] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">("idle");
  const [phase, setPhase] = useState<Phase>("show");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<SettleResult | null>(null);

  const localAddress = getLocalAccountSummary()?.address ?? null;

  // Poll the address + its liquid (unshielded) balance so "ready to import"
  // updates the moment the user's external deposit lands on-chain.
  const loadInfo = () =>
    api.depositInfo().then((i) => { setInfo(i); setInfoErr(false); }).catch(() => setInfoErr((had) => (info == null ? true : had)));
  useEffect(() => {
    let live = true;
    const tick = () => { if (live) void loadInfo(); };
    tick();
    const iv = setInterval(() => { if (!document.hidden && phase === "show") tick(); }, 8000);
    return () => { live = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const liquid = BigInt(info?.liquid ?? "0");
  const ready = liquid > 0n;
  const displayAddress = info?.address ?? localAddress;

  const [fallbackAssetCode, fallbackAssetIssuer] = (USDC_ASSET ?? "USDC:").split(":");
  const assetCode = info?.asset || fallbackAssetCode || "USDC";
  const assetIssuer = info?.issuer || fallbackAssetIssuer || "";

  // SEP-0007 payment URI so external wallets prefill the USDC asset (avoids users
  // sending XLM or the wrong asset). Falls back to the bare address if no issuer.
  const qrValue =
    displayAddress && assetIssuer
      ? `web+stellar:pay?destination=${displayAddress}&asset_code=${encodeURIComponent(assetCode)}&asset_issuer=${assetIssuer}`
      : (displayAddress ?? "");

  async function copy() {
    if (!displayAddress) return;
    const ok = await copyTextToClipboard(displayAddress);
    setCopyState(ok ? "copied" : "blocked");
    setTimeout(() => setCopyState("idle"), ok ? 1500 : 3000);
  }

  async function shieldIt() {
    setPhase("busy");
    setErr(null);
    try {
      const r = await api.importDeposit(); // shield all liquid
      setResult(r);
      setPhase("done");
      void refresh();
    } catch (e) {
      const m = (e as Error).message ?? "";
      setErr(/raw|invoke|0x|error\(|contract/i.test(m) ? "Couldn't import right now. Your money is safe - please try again." : m);
      setPhase("show");
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Receive" />
      <div className="px-5 pt-2">
        <p className="text-center text-[13.5px] text-muted">
          Share your address below so any wallet or exchange can pay you. It lands in your Public balance.
        </p>

        {/* QR + address */}
        <div className="mt-5 flex flex-col items-center gap-4 rounded-2xl border border-hair bg-card p-5">
          {displayAddress ? (
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <QRCodeSVG value={qrValue} size={168} level="M" />
            </div>
          ) : infoErr ? (
            <div className="flex h-[192px] w-[192px] flex-col items-center justify-center gap-2 rounded-xl bg-canvas text-center" data-testid="deposit-info-error">
              <div className="text-[12px] text-muted">Couldn't load your address.</div>
              <button onClick={() => { setInfoErr(false); void loadInfo(); }} className="rounded text-[13px] font-semibold text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="deposit-retry">Retry</button>
            </div>
          ) : (
            <div className="h-[192px] w-[192px] animate-pulse rounded-xl bg-canvas" />
          )}
          <div className="w-full">
            <div className="text-center text-[11px] font-semibold uppercase tracking-wide text-muted">Your USDC address (Stellar)</div>
            <button onClick={copy} aria-label={displayAddress ? `Copy receive address ${displayAddress}` : "Receive address loading"} className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-xl bg-canvas px-3 py-2.5 font-mono text-[12px] leading-tight text-ink transition outline-none hover:bg-canvas/70 focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="deposit-address">
              <span className="break-all text-left">{displayAddress ?? "…"}</span>
              {copyState === "copied" ? <Check size={14} className="flex-none text-pos" /> : <Copy size={14} className="flex-none text-muted" />}
            </button>
            {copyState !== "idle" ? (
              <div className={`mt-1 text-center text-[11.5px] font-semibold ${copyState === "copied" ? "text-pos" : "text-danger"}`} data-testid="deposit-copy-status">
                {copyState === "copied" ? "Address copied" : "Copy blocked. Select the address above."}
              </div>
            ) : !info?.address && displayAddress ? (
              <div className="mt-1.5 text-center text-[11px] font-semibold text-amber" data-testid="deposit-offline-warning">
                Confirming with network…
              </div>
            ) : null}
          </div>
          <div className="w-full rounded-xl bg-canvas/60 px-3 py-2 text-[11.5px] text-muted">
            <Row k="Asset" v={assetCode} />
            <Row k="Network" v={NETWORK_LABEL} />
            {assetIssuer ? <Row k="Issuer" v={`${assetIssuer.slice(0, 6)}…${assetIssuer.slice(-6)}`} /> : null}
          </div>
        </div>

        {/* Landed-in-Public + optional Make private CTA */}
        <div className="mt-4 rounded-2xl border border-hair bg-gradient-to-br from-accent/[0.06] to-transparent p-4" data-testid="deposit-ready">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted">Landed in Public</span>
            <span className={`tnum text-[15px] font-semibold ${ready ? "text-ink" : "text-muted"}`}>{fmtUsd(info?.liquid ?? "0")}</span>
          </div>
          <div className="mt-1 text-[11.5px] text-muted">
            {ready ? "When it lands, tap Make private to move it into your private balance." : "Waiting for your payment to land on-chain…"}
          </div>
        </div>

        <div className="mt-5 flex justify-center"><PrivateChip label="Make private hides the amount on-chain" /></div>

        <Button full size="lg" className="mt-3" disabled={!ready} loading={phase === "busy"} onClick={shieldIt} data-testid="deposit-shield">
          <ArrowDownToLine size={17} /> {ready ? `Make private · ${fmtUsd(info?.liquid ?? "0")}` : "Make private"}
        </Button>
        {err ? <div className="mt-2 text-center text-sm text-danger" data-testid="deposit-error">{err}</div> : null}
      </div>

      <AnimatePresence>
        {phase === "done" ? <ImportDone amount={result?.amount ?? "0"} onChain={!!result?.onChain} result={result} onDone={() => setPhase("show")} /> : null}
      </AnimatePresence>
    </Screen>
  );
}

function ImportDone({ amount, onChain, result, onDone }: { amount: string; onChain: boolean; result: SettleResult | null; onDone: () => void }) {
  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-canvas px-8 text-center"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} data-testid="deposit-overlay"
    >
      <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 240, damping: 16 }}
        className="flex h-16 w-16 items-center justify-center rounded-full bg-pos/12 text-pos">
        <ShieldCheck size={30} />
      </motion.div>
      <div>
        <div className="font-display text-2xl">Made private</div>
        <div className="mt-1 text-[15px] text-muted">{fmtUsd(amount)}{onChain ? "" : " · not verified on-chain"}</div>
      </div>
      {onChain ? (
        <div className="flex items-center gap-1.5 text-[12px] text-pos">
          <ShieldCheck size={13} /> It's now in your private balance - the amount is hidden on-chain
        </div>
      ) : null}
      <div className="w-full max-w-[320px]"><OnChainDetails txHash={result?.txHash} prover={result?.prover} provingMs={result?.provingMs} onChain={onChain} kind="shield" /></div>
      <Button className="mt-1" onClick={onDone}>Done</Button>
    </motion.div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-muted">{k}</span>
      <span className="font-medium text-ink">{v}</span>
    </div>
  );
}
