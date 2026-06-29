/**
 * Treasury - the org's two USDC balances and the prove actions.
 *
 * Two-balance model (same plain vocab as the wallet, never "shielded"):
 *   • Private - the M-of-N shielded pool (api.treasury). Only you can see it,
 *     paid privately Benzo-to-Benzo, provable on demand without revealing it.
 *   • Public - plain liquid USDC at the org's own address. This is what any
 *     external wallet or exchange sends to and receives from.
 * Convert: "Make private" (Public -> pool / shield = api.fundTreasury). There's
 * no "Make public" for the org treasury (M-of-N notes have no direct pool ->
 * public unshield), so it isn't offered. Send to a wallet is a real on-chain USDC
 * payment from Public; Receive shows the address + QR.
 *
 * The prove actions below stay unchanged: each is a real Groth16 proof verified
 * on-chain, every result carries an on-chain reference you can re-verify.
 */
import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Eye, EyeOff, QrCode as QrIcon, Send, ShieldCheck, Wallet } from "lucide-react";
import { api, type OnChainRef } from "../lib/api";
import { useConsole } from "../lib/store";
import { explorerTxUrl, fmtUsd, formatAddress, friendlyError } from "../lib/format";
import { NETWORK_LABEL } from "../lib/network";
import { Page, Proving, Reveal, Stagger } from "../ui/motion";
import { OnChainDetail } from "../ui/onchain";
import { QrCode } from "../ui/qr";
import { AddressDisplay, Button, Card, CopyButton, Input, Modal, Pill, Skeleton, useToast } from "../ui/primitives";

/** USDC (human) -> stroops (7dp), matching the BFF. Empty/NaN -> "0". */
function toStroops(usd: string): string {
  return (BigInt(Math.round((Number(usd) || 0) * 1e7)) || 0n).toString();
}

export function Treasury() {
  const toast = useToast();
  const { treasury, masked, loading, refresh } = useConsole();

  // ---- Public balance + receive coordinates (two-balance model) -------------
  const [pub, setPub] = useState<{ stroops: string; address: string; asset: string; issuer: string; live: boolean } | null>(null);
  const [pubLoading, setPubLoading] = useState(true);

  async function loadPublic() {
    try {
      setPub(await api.treasuryPublicBalance());
    } catch {
      /* leave prior value; the public card shows a calm "-" */
    } finally {
      setPubLoading(false);
    }
  }
  useEffect(() => {
    void loadPublic();
  }, []);

  // ---- Make private (Fund / shield): Public -> pool -------------------------
  const [fundAmt, setFundAmt] = useState("0.20");
  const [busyFund, setBusyFund] = useState(false);
  const [confirmFund, setConfirmFund] = useState(false);
  const [fundResult, setFundResult] = useState<{ onChain: boolean; txHash?: string; error?: string } | null>(null);

  async function fund() {
    setBusyFund(true);
    setFundResult(null);
    try {
      const r = await api.fundTreasury(fundAmt);
      if (r.onChain) {
        setFundResult({ onChain: true, txHash: r.txHash });
        toast({ title: `Made private · ${fundAmt} USDC`, tone: "success" });
        await Promise.all([refresh(), loadPublic()]);
      } else {
        setFundResult({ onChain: false, error: r.error ?? "Couldn't move to Private on-chain" });
        toast({ title: r.error ?? "Couldn't move to Private on-chain", tone: "danger" });
      }
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusyFund(false);
    }
  }

  // Note: there is no "Make public" for the org treasury - it's held as M-of-N
  // notes with no direct pool -> public unshield path, so we don't offer it.

  // ---- Send to a wallet (real public on-chain USDC payment) -----------------
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const [busySend, setBusySend] = useState(false);
  const [sendResult, setSendResult] = useState<{ onChain: boolean; txHash?: string; error?: string } | null>(null);
  const addrLooksValid = /^G[A-Z2-7]{55}$/.test(sendTo.trim());

  async function sendPublic(): Promise<boolean> {
    setBusySend(true);
    setSendResult(null);
    try {
      const r = await api.treasurySendPublic(sendTo.trim(), sendAmt);
      if (r.onChain) {
        setSendResult({ onChain: true, txHash: r.txHash });
        toast({ title: `Sent ${sendAmt} USDC to a wallet`, tone: "success" });
        setSendTo("");
        setSendAmt("");
        await loadPublic();
        return true;
      } else {
        setSendResult({ onChain: false, error: r.error });
        toast({ title: r.error ?? "Couldn't send", tone: "danger" });
        return false;
      }
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
      setSendResult({ onChain: false, error: friendlyError(e) });
      return false;
    } finally {
      setBusySend(false);
    }
  }

  // ---- Receive (address + QR) ----------------------------------------------
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [recv, setRecv] = useState<{ address: string; asset: string; issuer: string; live: boolean } | null>(null);
  const [recvLoading, setRecvLoading] = useState(false);

  async function openReceive() {
    setReceiveOpen(true);
    if (recv?.address) return;
    setRecvLoading(true);
    try {
      setRecv(await api.treasuryReceive());
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setRecvLoading(false);
    }
  }

  // ---- ZK prove actions (unchanged) ----------------------------------------
  const [min, setMin] = useState("100000");
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<{ holds: boolean; onChain: boolean; ref?: OnChainRef } | null>(null);
  const [busyTotal, setBusyTotal] = useState(false);
  const [totalProof, setTotalProof] = useState<{ total: string; onChain: boolean; ref?: OnChainRef } | null>(null);
  const [busySolv, setBusySolv] = useState(false);
  const [solvProof, setSolvProof] = useState<{ solvent: boolean; onChain: boolean; liabilities: string; ref?: OnChainRef } | null>(null);

  async function prove() {
    setBusy(true);
    setProof(null);
    try {
      const minStroops = toStroops(min);
      const r = await api.proveBalance(minStroops);
      setProof({ holds: r.holds, onChain: r.onChain, ref: r.ref ? { ...r.ref, label: "Reserves proof" } : undefined });
      toast({ title: r.holds ? (r.onChain ? "Reserves verified on-chain" : "Proof was not verified on-chain") : "Below the floor (proven)", tone: r.holds && r.onChain ? "success" : "danger" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function proveSolvent() {
    setBusySolv(true);
    setSolvProof(null);
    try {
      const r = await api.proveSolvency();
      setSolvProof({ ...r, ref: r.ref ? { ...r.ref, label: "Solvency proof" } : undefined });
      toast({ title: r.onChain ? (r.solvent ? "Solvency proven on-chain" : "Not solvent (proven)") : "Proof was not verified on-chain", tone: r.solvent && r.onChain ? "success" : "danger" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusySolv(false);
    }
  }

  async function proveExactTotal() {
    setBusyTotal(true);
    setTotalProof(null);
    try {
      const r = await api.proveTotal();
      setTotalProof({ ...r, ref: r.ref ? { ...r.ref, label: "Period total proof" } : undefined });
      toast({ title: r.onChain ? "Total proven on-chain" : "Proof was not verified on-chain", tone: r.onChain ? "success" : "danger" });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setBusyTotal(false);
    }
  }

  const publicUsd = pub ? fmtUsd(pub.stroops) : "$0.00";

  return (
    <Page>
      <div className="mb-5">
        <h1 className="font-display text-2xl">Treasury</h1>
        <p className="mt-1 text-[13.5px] text-muted">Two balances · Private stays hidden and provable · Public sends to and receives from any wallet</p>
      </div>

      {/* ---- Two-balance header: Private (shielded) + Public ----------------- */}
      <div className="mb-4 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        {/* Private (shielded) - the main shielded position */}
        <Card className="flex flex-col p-5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
            Private (shielded)
            <Pill tone="shielded">
              <ShieldCheck size={12} /> Provable on demand
            </Pill>
          </div>
          {loading ? (
            <Skeleton className="mt-2 h-10 w-56" />
          ) : (
            <div className="font-display tnum mt-2 text-[40px] leading-none" data-testid="treasury-total">
              {masked ? "••••••" : fmtUsd(treasury?.totalHidden.amount ?? "0")}
            </div>
          )}
          <div className="mt-auto pt-2 text-[12.5px] text-muted">Only you can see this · sent privately to a Benzo @handle</div>
        </Card>

        {/* Public - plain liquid USDC any wallet/exchange sees */}
        <Card className="flex flex-col p-5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
            Public
            <Pill tone="muted">
              <Eye size={12} /> Visible on-chain
            </Pill>
          </div>
          {pubLoading && !pub ? (
            <Skeleton className="mt-2 h-10 w-56" />
          ) : (
            <div className="font-display tnum mt-2 text-[40px] leading-none text-[#2c3744]" data-testid="public-balance">
              {masked ? "••••••" : publicUsd}
            </div>
          )}
          <div className="mt-auto pt-2 text-[12.5px] text-muted">Normal USDC. Send to or receive from any wallet or exchange.</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="md" onClick={() => void openReceive()} data-testid="receive-open">
              <ArrowDownToLine size={15} /> Receive
            </Button>
            <Button variant="outline" size="md" onClick={() => setConfirmSend(true)} disabled={!pub?.live} title={pub?.live ? undefined : "Connect to a live network to send"} data-testid="send-wallet-open">
              <Send size={15} /> Send to a wallet
            </Button>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* left: convert actions + accounts */}
        <div className="space-y-4">
          {/* Make private: Public -> shielded pool. (Make public isn't offered - the org
              treasury is M-of-N and has no direct pool -> public unshield path.) */}
          <div className="grid grid-cols-1 gap-4">
            {/* Make private (shield) - was "Fund treasury" */}
            <Card className="flex flex-col p-5">
              <div className="flex items-center gap-2 text-[14px] font-semibold">
                <EyeOff size={16} className="text-shielded" /> Make private
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                Move USDC from Public into the private pool. It lands as an M-of-N org note - dual-controlled the moment it arrives.
              </p>
              <div className="mt-4">
                <Input
                  label="Amount (USDC)"
                  inputMode="decimal"
                  value={fundAmt}
                  onChange={(e) => {
                    setFundResult(null);
                    setFundAmt(e.target.value.replace(/[^0-9.]/g, ""));
                  }}
                  data-testid="fund-amount"
                />
              </div>
              {busyFund ? (
                <Proving className="mt-4" steps={["Moving USDC into the private pool", `Settling on the Stellar ${NETWORK_LABEL} network`]} />
              ) : (
                <Button className="mt-4 w-full" onClick={() => setConfirmFund(true)} disabled={!(Number(fundAmt) > 0)} data-testid="fund-treasury">Make private</Button>
              )}
              {fundResult ? (
                <Reveal
                  tone={fundResult.onChain ? "success" : "danger"}
                  className={`mt-4 rounded-lg border px-4 py-3 ${fundResult.onChain ? "border-success/30 bg-success/8" : "border-danger/30 bg-danger/8"}`}
                  data-testid="fund-result"
                >
                  {fundResult.onChain ? (
                    <>
                      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1d7a52]">
                        <ShieldCheck size={14} /> Moved to Private on-chain
                      </div>
                      {fundResult.txHash ? (
                        <a href={explorerTxUrl(fundResult.txHash)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">
                          View on explorer <ArrowUpRight size={12} />
                        </a>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#b4232a]">
                      <ShieldCheck size={14} /> {fundResult.error ?? "Move to Private failed on-chain"}
                    </div>
                  )}
                </Reveal>
              ) : null}
            </Card>
          </div>

          {/* Accounts inside the private pool */}
          {loading && !treasury ? (
            <div className="space-y-4">
              {[0, 1].map((i) => (
                <Card key={i} className="flex items-center gap-3 p-4">
                  <Skeleton className="h-11 w-11 flex-none rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-5 w-20" />
                </Card>
              ))}
            </div>
          ) : (treasury?.accounts ?? []).length === 0 ? (
            <Card className="p-8 text-center text-[13px] text-muted">No accounts connected yet.</Card>
          ) : (
            <Stagger className="space-y-4">
              {(treasury?.accounts ?? []).map((a, i) => (
                <Stagger.Item key={a.account.id} index={i}>
                  <Card className="flex items-center gap-3 p-4">
                    <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Wallet size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14.5px] font-semibold">{a.account.name}</div>
                      <div className="truncate text-[12.5px] capitalize text-muted">{a.account.type} · {a.account.assetCode}</div>
                    </div>
                    <div className="font-display tnum flex-none text-lg text-[#2c3744]">
                      {a.balance ? (masked ? "••••" : fmtUsd(a.balance.amount)) : <span className="mask">private</span>}
                    </div>
                  </Card>
                </Stagger.Item>
              ))}
            </Stagger>
          )}
        </div>

        {/* right: ZK prove cards (unchanged) */}
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <ShieldCheck size={16} className="text-primary" /> Prove reserves
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              Prove to a lender or your board that the treasury clears a covenant floor - verifiable on-chain. The real figure stays private.
            </p>
            <div className="mt-4">
              <Input label="Prove we hold at least (USDC)" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="prove-min" />
            </div>
            {busy ? (
              <Proving className="mt-4" steps={["Building witness", "Generating Groth16 proof", "Verifying on-chain"]} />
            ) : (
              <Button className="mt-4 w-full" onClick={prove} data-testid="prove-balance">Generate proof</Button>
            )}
            {proof ? (
              <Reveal tone={proof.holds && proof.onChain ? "success" : "danger"} className={`mt-4 rounded-lg border px-4 py-3 ${proof.holds && proof.onChain ? "border-success/30 bg-success/8" : "border-danger/30 bg-danger/8"}`} data-testid="prove-result">
                <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${proof.holds && proof.onChain ? "text-[#1d7a52]" : "text-[#b4232a]"}`}>
                  <ShieldCheck size={14} /> {proof.holds ? `Holds ≥ ${fmtUsd(toStroops(min))}` : "Below the requested floor"}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[12px] text-muted">
                  <span>{proof.onChain ? "Anyone can verify this independently." : "Proof was not verified on-chain."}</span>
                  {proof.ref ? <OnChainDetail refData={proof.ref} /> : null}
                </div>
              </Reveal>
            ) : null}
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <ShieldCheck size={16} className="text-primary" /> Disclose exact total
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              For an auditor who needs the precise figure: a zero-knowledge proof that your shielded notes sum to an exact total, verifiable on-chain. Individual amounts stay hidden.
            </p>
            {busyTotal ? (
              <Proving className="mt-4" steps={["Summing notes in zero-knowledge", "Verifying the sum proof on-chain"]} />
            ) : (
              <Button variant="outline" className="mt-4 w-full" onClick={proveExactTotal} data-testid="prove-total">Prove exact total</Button>
            )}
            {totalProof ? (
              <Reveal tone={totalProof.onChain ? "success" : "danger"} className={`mt-4 rounded-lg border px-4 py-3 ${totalProof.onChain ? "border-success/30 bg-success/8" : "border-danger/30 bg-danger/8"}`} data-testid="prove-total-result">
                <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${totalProof.onChain ? "text-[#1d7a52]" : "text-[#b4232a]"}`}>
                  <ShieldCheck size={14} /> Total: {fmtUsd(totalProof.total)}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[12px] text-muted">
                  <span>{totalProof.onChain ? "Proven, not asserted." : "Proof was not verified on-chain."}</span>
                  {totalProof.ref ? <OnChainDetail refData={totalProof.ref} /> : null}
                </div>
              </Reveal>
            ) : null}
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <ShieldCheck size={16} className="text-primary" /> Prove solvency
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              One click proves your treasury covers everything you owe - pending payroll plus open invoices - verifiable on-chain. Neither your balance nor what you owe is revealed.
            </p>
            {busySolv ? (
              <Proving className="mt-4" steps={["Summing liabilities privately", "Proving assets ≥ liabilities", "Verifying on-chain"]} />
            ) : (
              <Button variant="outline" className="mt-4 w-full" onClick={proveSolvent} data-testid="prove-solvency">Prove assets ≥ liabilities</Button>
            )}
            {solvProof ? (
              <Reveal tone={solvProof.solvent && solvProof.onChain ? "success" : "danger"} className={`mt-4 rounded-lg border px-4 py-3 ${solvProof.solvent && solvProof.onChain ? "border-success/30 bg-success/8" : "border-danger/30 bg-danger/8"}`} data-testid="prove-solvency-result">
                <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${solvProof.solvent && solvProof.onChain ? "text-[#1d7a52]" : "text-[#b4232a]"}`}>
                  <ShieldCheck size={14} /> {solvProof.solvent ? "Solvent - assets cover all liabilities" : "Not solvent - liabilities exceed treasury"}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[12px] text-muted">
                  <span>{solvProof.onChain ? "The network verified it." : "Proof was not verified on-chain."}</span>
                  {solvProof.ref ? <OnChainDetail refData={solvProof.ref} /> : null}
                </div>
              </Reveal>
            ) : null}
          </Card>
        </div>
      </div>

      {/* ---- Make private confirm modal ------------------------------------- */}
      <Modal
        open={confirmFund}
        onClose={() => setConfirmFund(false)}
        title="Make private"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmFund(false)}>Cancel</Button>
            <Button loading={busyFund} onClick={() => { setConfirmFund(false); void fund(); }} data-testid="fund-confirm">
              <EyeOff size={15} /> Make {fmtUsd(toStroops(fundAmt))} private
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            This moves <b>real USDC</b> on the Stellar {NETWORK_LABEL} network from your Public balance into the private pool - a dual-controlled M-of-N org note. It settles on-chain and <b>can't be undone</b> from here.
          </p>
          <p className="text-[12.5px] leading-relaxed text-muted">
            Proof location: TEE. The Console prover creates the shield proof outside the browser before the on-chain settlement is accepted.
          </p>
          <div className="space-y-2 rounded-xl bg-canvas p-4 text-[14px]">
            <div className="flex justify-between"><span className="text-muted">Amount</span><span className="font-display tnum font-semibold">{fmtUsd(toStroops(fundAmt))}</span></div>
            <div className="flex justify-between"><span className="text-muted">From</span><span className="font-semibold">Public</span></div>
            <div className="flex justify-between"><span className="text-muted">Into</span><span className="font-semibold">Private (M-of-N note)</span></div>
            <div className="flex justify-between"><span className="text-muted">Proof location</span><span className="font-semibold">TEE</span></div>
          </div>
        </div>
      </Modal>

      {/* ---- Send to a wallet confirm modal --------------------------------- */}
      <Modal
        open={confirmSend}
        onClose={() => { if (!busySend) setConfirmSend(false); }}
        title="Send to a wallet"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmSend(false)} disabled={busySend}>Cancel</Button>
            <Button
              loading={busySend}
              disabled={!addrLooksValid || !(Number(sendAmt) > 0)}
              onClick={() => {
                void sendPublic().then((ok) => {
                  if (ok) setConfirmSend(false);
                });
              }}
              data-testid="send-wallet-confirm"
            >
              <Send size={15} /> Send {Number(sendAmt) > 0 ? fmtUsd(toStroops(sendAmt)) : "USDC"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            label="Recipient wallet address"
            placeholder="G…"
            spellCheck={false}
            value={sendTo}
            onChange={(e) => {
              setSendResult(null);
              setSendTo(e.target.value.trim());
            }}
            error={sendTo.length > 0 && !addrLooksValid ? "That doesn't look like a valid wallet address." : undefined}
            data-testid="send-wallet-to"
          />
          <Input
            label="Amount (USDC)"
            inputMode="decimal"
            placeholder="0.00"
            value={sendAmt}
            onChange={(e) => {
              setSendResult(null);
              setSendAmt(e.target.value.replace(/[^0-9.]/g, ""));
            }}
            data-testid="send-wallet-amount"
          />
          <div className="rounded-lg border border-warning/30 bg-warning/8 px-4 py-3 text-[12.5px] leading-relaxed text-[#7a5a12]">
            This is a <b>public on-chain payment</b> from your Public balance - visible to anyone and <b>can't be undone</b>. To pay a Benzo user privately instead, use Send privately to their @handle.
          </div>
          {sendResult?.error ? (
            <Reveal tone="danger" className="rounded-lg border border-danger/30 bg-danger/8 px-4 py-3 text-[12.5px] font-medium text-[#b4232a]" data-testid="send-wallet-error">
              {sendResult.error}
            </Reveal>
          ) : null}
          {sendResult?.onChain ? (
            <Reveal tone="success" className="rounded-lg border border-success/30 bg-success/8 px-4 py-3" data-testid="send-wallet-result">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1d7a52]">
                <Send size={14} /> Sent on-chain
              </div>
              {sendResult.txHash ? (
                <a href={explorerTxUrl(sendResult.txHash)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">
                  View on explorer <ArrowUpRight size={12} />
                </a>
              ) : null}
            </Reveal>
          ) : null}
        </div>
      </Modal>

      {/* ---- Receive modal (address + QR) ----------------------------------- */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Receive USDC">
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-muted">
            Share this address (or QR) with any wallet or exchange to be paid in USDC. It lands in your <b>Public</b> balance - then Make private if you want it hidden.
          </p>
          {recvLoading && !recv ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <Skeleton className="h-[168px] w-[168px] rounded-xl" />
              <Skeleton className="h-4 w-64" />
            </div>
          ) : recv?.address ? (
            <>
              <div className="flex justify-center">
                {QrCode({ value: recv.address, size: 168 }) ?? (
                  <div className="flex h-[168px] w-[168px] items-center justify-center rounded-xl border border-dashed border-border text-muted">
                    <QrIcon size={32} />
                  </div>
                )}
              </div>
              <div className="rounded-xl bg-canvas p-4">
                <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-muted">Your USDC address</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="break-all font-mono text-[12px] text-fg" data-testid="receive-address">{recv.address}</span>
                  <span className="flex-none"><CopyButton value={recv.address} /></span>
                </div>
                {recv.issuer ? (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted">
                    <span>Asset · {recv.asset}</span>
                    <AddressDisplay address={recv.issuer} head={4} tail={4} />
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="rounded-xl bg-canvas p-6 text-center text-[13px] text-muted" data-testid="receive-unavailable">
              A receive address is available when connected to a live network.
            </div>
          )}
        </div>
      </Modal>
    </Page>
  );
}
