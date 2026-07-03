import { useCallback, useReducer, useState } from "react";
import { paymentReducer, initialPaymentState, type PaymentState } from "@benzo/ui/payment-state";
import { type ProverKind, type SettleResult, type SendPhaseEvent } from "./api";
import { clientSideReadsAvailable, sendClientSide } from "./benzoClient";
import { usdcToStroops } from "./format";
import { decodeRecipient } from "./recipient";
import { saveLocalHistory } from "./history";

export function useSendStream() {
  const [state, dispatch] = useReducer(paymentReducer, initialPaymentState);
  const [receipt, setReceipt] = useState<SettleResult | null>(null);

  const apply = useCallback((e: SendPhaseEvent) => {
    if (e.phase === "failed") {
      dispatch({ type: "FAIL", error: e.error ?? "Couldn't send" });
      return;
    }
    dispatch({ type: "START" });
    if (e.phase === "building") return;
    dispatch({ type: "WITNESS_READY" });
    if (e.phase === "proving") return;
    dispatch({ type: "PROOF_READY", provingMs: e.provingMs });
    if (e.txHash) dispatch({ type: "SUBMITTED", txHash: e.txHash });
    if (e.phase === "submitting") return;
    dispatch({ type: "CONFIRMED" });
  }, []);

  const run = useCallback(
    async (to: string, amount: string, memo: string | undefined, prover: ProverKind, _proverAvailable = false, requestId?: string) => {
      dispatch({ type: "RESET" });
      setReceipt(null);
      dispatch({ type: "START" });
      try {
        const recipient = decodeRecipient(to);
        if (!recipient) {
          throw new Error("Invalid private recipient code.");
        }
        apply({ phase: "proving" });
        const cs = await sendClientSide(recipient, usdcToStroops(amount).toString());
        if (cs?.txHash) {
          const r: SettleResult = { status: "settled", txHash: cs.txHash, prover: cs.prover, amount: usdcToStroops(amount).toString(), onChain: true };
          saveLocalHistory({
            id: cs.txHash,
            type: "send",
            name: to.startsWith("bzr_") ? `${to.slice(0, 10)}...${to.slice(-8)}` : to,
            note: memo || "",
            amount: usdcToStroops(amount).toString(),
            direction: "out",
            status: "settled",
            timestamp: Math.floor(Date.now() / 1000),
            txHash: cs.txHash,
          });
          setReceipt(r);
          apply({ phase: "confirmed", txHash: cs.txHash, onChain: true });
          return r;
        }
        throw new Error("Local-first send failed to return transaction hash.");
      } catch (err) {
        dispatch({ type: "FAIL", error: (err as Error).message });
        return null;
      }
    },
    [apply],
  );

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
    setReceipt(null);
  }, []);

  return { state: state as PaymentState, receipt, run, reset };
}
