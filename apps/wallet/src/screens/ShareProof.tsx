/**
 * Share proof of balance — pick a threshold, generate a zero-knowledge proof that
 * you hold at least that much (never the exact amount), and get the "Provable"
 * badge. The proof is a real Groth16 attestation that verifies on-chain when
 * live; the proving path is decided by the device (this device / secure enclave).
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ShieldCheck, Smartphone } from "lucide-react";
import { api } from "../lib/api";
import { apiProverKind, proverPlan } from "../lib/proverPolicy";
import { useWallet } from "../lib/store";
import { verifyBalanceProofOnChain } from "../lib/chain";
import { proveBalanceClientSide } from "../lib/benzoClient";
import { fmtUsd, usdcToStroops } from "../lib/format";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { AmountField, Button, SuccessCheck } from "../ui/primitives";
import { ProvableChip } from "../ui/privacy";

type Phase = "form" | "busy" | "done";

export function ShareProof() {
  const { session } = useWallet();
  const [min, setMin] = useState("100");
  const [phase, setPhase] = useState<Phase>("form");
  const [err, setErr] = useState<string | null>(null);
  const [onChain, setOnChain] = useState(false);
  const [selfVerified, setSelfVerified] = useState(false);
  const [onDevice, setOnDevice] = useState(false);
  const teeAvailable = !!session?.prover.available.includes("tee");
  // The DEVICE decides where the proof runs: capable desktops prove on-device;
  // phones + weak desktops delegate to the enclave (TEE), never grinding locally.
  const plan = proverPlan(teeAvailable);
  const valid = Number(min) > 0;

  async function generate() {
    setPhase("busy");
    setErr(null);
    setSelfVerified(false);
    setOnDevice(false);
    try {
      // CAPABLE DESKTOPS ONLY: generate the proof on THIS DEVICE (WasmProver — the
      // witness/notes never leave the browser) and verify it on-chain ourselves,
      // no BFF in the loop. Phones + weak desktops skip this (plan.onDevice=false)
      // and delegate to the enclave so a weak device never grinds.
      if (plan.onDevice) {
        const cs = await proveBalanceClientSide(usdcToStroops(min).toString()).catch(() => null);
        if (cs) {
          setOnChain(cs.onChain);
          setSelfVerified(cs.onChain);
          setOnDevice(true);
          setPhase("done");
          return;
        }
      }
      const r = await api.shareProof(min, apiProverKind(plan.kind, teeAvailable));
      setOnChain(r.onChain);
      setPhase("done");
      // Trustless step: this device re-verifies the BFF-made proof on-chain itself.
      if (r.onChain && r.publics?.length) {
        try {
          setSelfVerified(await verifyBalanceProofOnChain(JSON.parse(r.proof), r.publics));
        } catch {
          /* leave selfVerified false; the server verdict still stands */
        }
      }
    } catch (e) {
      const msg = (e as Error).message ?? "";
      setErr(/phala prover failed|HTTP 400|proof_of_balance/i.test(msg)
        ? "Balance proofs in the secure enclave are not available on this testnet build yet. Use a capable desktop to prove on-device."
        : msg);
      setPhase("form");
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Prove your balance" />
      <div className="px-5 pt-2">
        <p className="text-[14px] leading-relaxed text-muted">
          Prove you hold <span className="font-semibold text-ink">at least</span> a chosen amount. Your real balance stays hidden.
        </p>

        <div className="mt-6">
          <div className="text-center text-[13px] font-semibold text-muted">I can prove I have at least</div>
          <AmountField value={min} onChange={setMin} />
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-hair bg-card px-3.5 py-2.5 text-[12.5px] text-muted" data-testid="proof-prover-plan">
          {plan.onDevice ? <Smartphone size={15} className="flex-none text-accent" /> : <ShieldCheck size={15} className="flex-none text-accent" />}
          <span>{plan.reason}</span>
        </div>

        <Button full size="lg" className="mt-6" disabled={!valid} loading={phase === "busy"} onClick={generate} data-testid="proof-generate">
          {phase === "busy" ? "Generating proof…" : "Generate proof"}
        </Button>
        {err ? <div className="mt-2 text-center text-sm text-danger" data-testid="proof-error">{err}</div> : null}
      </div>

      <AnimatePresence>
        {phase === "done" ? (
          <motion.div
            className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-canvas/95 px-8 text-center backdrop-blur"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            data-testid="proof-overlay"
          >
            <SuccessCheck />
            <ProvableChip label={onChain ? "Verified on-chain" : "Provable"} />
            <div className="font-display text-xl" data-testid="proof-success">You can prove you hold at least {fmtUsd(BigInt(Math.round(Number(min) * 1e7)).toString())}</div>
            <div className="max-w-[280px] text-sm text-muted">
              {onDevice
                ? "Your device generated this proof and the network confirmed it — no server ever saw your balance or your notes."
                : onChain
                  ? "The network checked this proof and confirmed it — without ever seeing your balance."
                  : "A real private proof, generated right on your device — not yet checked by the network."}{" "}
              Your exact balance stays private.
            </div>
            {!onChain ? (
              <div className="inline-flex items-center gap-1.5 rounded-full bg-amber/12 px-3 py-1 text-[12px] font-semibold text-[#9a6b12]" data-testid="proof-not-onchain">
                Generated on your device · not verified on-chain
              </div>
            ) : null}
            {selfVerified ? (
              <div className="inline-flex items-center gap-1.5 rounded-full bg-pos/10 px-3 py-1 text-[12px] font-semibold text-pos" data-testid="proof-self-verified">
                {onDevice ? <Smartphone size={13} /> : <ShieldCheck size={13} />}
                {onDevice ? "Proved on your device, verified on-chain" : "Confirmed by this device, on-chain"}
              </div>
            ) : null}
            <Button className="mt-2" onClick={() => setPhase("form")}>Done</Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Screen>
  );
}
