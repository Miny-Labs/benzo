/**
 * OnChainDetails — a "not-too-hidden" Advanced disclosure that turns any Benzo
 * action into something a technical reviewer (or a curious user) can verify on
 * the public ledger, WITHOUT cluttering the web2-clean default view.
 *
 * Collapsed by default ("Advanced · on-chain details"); one tap reveals the real
 * facts behind the abstracted UI: the settlement tx (Stellar Expert link), the
 * verifier + pool contract ids, what the ZK proof proved, where it was generated
 * (this device vs the attested TEE) and how long it took, and the privacy
 * invariant in technical terms. Everything here is PUBLIC chain data — never a
 * secret — which is exactly the point: privacy holds even though the proof is
 * publicly checkable.
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { DEPLOYMENT, NETWORK, NETWORK_LABEL } from "../lib/network";

const EXPLORER = `https://stellar.expert/explorer/${NETWORK}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerContract = (id: string) => `${EXPLORER}/contract/${id}`;
const short = (s: string, n = 6) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export type OnChainKind = "shield" | "transfer" | "unshield" | "proof";

const KIND_PROOF: Record<OnChainKind, { circuit: string; statement: string }> = {
  shield: { circuit: "SHIELD", statement: "the deposit commits to a hidden note (amount + owner sealed) admitted by a KYC/ASP proof" },
  transfer: { circuit: "TRANSFER (joinsplit)", statement: "inputs = outputs + fee, you own the inputs, and the nullifiers are fresh — amount + counterparty hidden" },
  unshield: { circuit: "UNSHIELD", statement: "you own the note being withdrawn and it is NOT on the deny-list (proof-of-innocence)" },
  proof: { circuit: "BALANCE / SUM", statement: "a balance/total claim holds — without revealing the amounts" },
};

export function OnChainDetails({
  txHash,
  prover,
  provingMs,
  onChain,
  kind = "transfer",
}: {
  txHash?: string;
  prover?: "local" | "tee";
  provingMs?: number;
  onChain?: boolean;
  kind?: OnChainKind;
}) {
  const [open, setOpen] = useState(false);
  if (!onChain) return null; // nothing real to point at
  const p = KIND_PROOF[kind];
  const proverLabel = prover === "tee" ? "Secure enclave (Phala TEE, attested)" : "This device (in-browser)";

  return (
    <div className="w-full rounded-2xl border border-hair bg-card/60" data-testid="onchain-details">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-[12.5px] font-semibold text-muted transition hover:text-ink"
        data-testid="onchain-toggle"
      >
        <span className="flex items-center gap-1.5">Advanced · on-chain details</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}><ChevronDown size={15} /></motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }} className="overflow-hidden"
          >
            <div className="space-y-2.5 border-t border-hair px-4 py-3 text-[12px]">
              <Row k="Network" v={NETWORK_LABEL} />
              <Row k="Proof" v={`Groth16 / BN254 · ${p.circuit}`} />
              <Row k="Verified on-chain" v={<span className="font-semibold text-pos">Yes · inside the pool contract</span>} />
              <Row k="What it proves" v={<span className="text-ink">{p.statement}</span>} />
              <Row k="Proven on" v={`${proverLabel}${provingMs ? ` · ${(provingMs / 1000).toFixed(2)}s` : ""}`} />
              {txHash ? <LinkRow k="Settlement tx" id={txHash} href={explorerTx(txHash)} /> : null}
              <LinkRow k="Pool contract" id={DEPLOYMENT.pool} href={explorerContract(DEPLOYMENT.pool)} />
              <LinkRow k="Groth16 verifier" id={DEPLOYMENT.verifier} href={explorerContract(DEPLOYMENT.verifier)} />
              <div className="pt-1 text-[11px] leading-snug text-muted">
                Everything here is public — yet your amount, balance and counterparty stay hidden. That is the zero-knowledge guarantee:
                the network verified the payment is valid without learning what it was.
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex-none text-muted">{k}</span>
      <span className="text-right text-ink">{v}</span>
    </div>
  );
}

function LinkRow({ k, id, href }: { k: string; id: string; href: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex-none text-muted">{k}</span>
      <span className="flex items-center gap-1.5">
        <a href={href} target="_blank" rel="noreferrer" className="font-mono text-[11.5px] text-accent hover:underline">{short(id)}</a>
        <button type="button" onClick={() => navigator.clipboard?.writeText(id).catch(() => {})} title="Copy" className="text-muted hover:text-ink"><Copy size={12} /></button>
        <a href={href} target="_blank" rel="noreferrer" title="Open in Stellar Expert" className="text-muted hover:text-ink"><ExternalLink size={12} /></a>
      </span>
    </div>
  );
}
