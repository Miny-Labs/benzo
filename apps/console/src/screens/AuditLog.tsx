/**
 * Audit log - the tamper-evident double-entry ledger, finally on screen. Every
 * shielded movement projects to a balanced entry whose hash commits to the one
 * before it, so any after-the-fact edit/insert/delete breaks the chain from that
 * point on. "Verify chain" re-walks it and proves integrity; each entry links to
 * its on-chain settlement. This is the CFO/auditor-readable side of private money.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Download, ExternalLink, FileKey2, ScrollText, ShieldAlert } from "lucide-react";
import type { LedgerEntry, LedgerSourceType } from "@benzo/types";
import { api, type PrivateAuditAnchorResponse, type PrivateAuditPacketResponse } from "../lib/api";
import { explorerTxUrl, fmtUsd, formatAddress, formatDate, friendlyError } from "../lib/format";
import { Page, Proving, Reveal, Stagger } from "../ui/motion";
import { Button, Card, EmptyState, Pill, Skeleton, useToast } from "../ui/primitives";

const sourceTone: Record<LedgerSourceType, "shielded" | "success" | "warning" | "danger" | "muted"> = {
  shield: "shielded",
  transfer: "shielded",
  payroll: "success",
  invoice: "success",
  unshield: "warning",
  onramp: "success",
  offramp: "warning",
  fee: "muted",
  reversal: "danger",
};

/** Gross of an entry = sum of its credit legs (debits net to the same number). */
function entryGross(e: LedgerEntry): string {
  return e.lines.filter((l) => l.direction === "credit").reduce((s, l) => s + BigInt(l.amount), 0n).toString();
}

export function AuditLog() {
  const toast = useToast();
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [integrity, setIntegrity] = useState<{ ok: boolean; length: number; brokenAt?: number } | null>(null);
  const [privateAudit, setPrivateAudit] = useState<PrivateAuditPacketResponse | null>(null);
  const [privateAnchor, setPrivateAnchor] = useState<PrivateAuditAnchorResponse | null>(null);
  const [privateAuditError, setPrivateAuditError] = useState<string | null>(null);
  const [loadingPrivateAudit, setLoadingPrivateAudit] = useState(false);
  const [anchoringPrivateAudit, setAnchoringPrivateAudit] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    api
      .ledger()
      .then((r) => live && setEntries(r))
      .catch((e) => {
        if (!live) return;
        setLoadError(friendlyError(e, "Couldn't load the audit log."));
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  async function verifyChain() {
    setVerifying(true);
    setIntegrity(null);
    try {
      const r = await api.ledgerVerify();
      setIntegrity(r);
      toast({
        title: r.ok ? `Chain intact - ${r.length} entries verified` : `Tampering detected at entry #${r.brokenAt}`,
        tone: r.ok ? "success" : "danger",
      });
    } catch (e) {
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setVerifying(false);
    }
  }

  async function loadPrivateAuditPacket() {
    setLoadingPrivateAudit(true);
    setPrivateAuditError(null);
    try {
      const r = await api.privateAuditPacket();
      setPrivateAudit(r);
      setPrivateAnchor(null);
      toast({
        title: r.integrity.ok ? `Private packet ready · ${r.packet.envelopes.length} encrypted events` : "Private event chain failed integrity",
        tone: r.integrity.ok ? "success" : "danger",
      });
    } catch (e) {
      setPrivateAuditError(friendlyError(e, "Couldn't load the private audit packet."));
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setLoadingPrivateAudit(false);
    }
  }

  async function anchorPrivateAuditRoot() {
    setAnchoringPrivateAudit(true);
    setPrivateAuditError(null);
    try {
      const r = await api.anchorPrivateAuditRoot(privateAudit ? { packet: privateAudit.packet } : undefined);
      setPrivateAudit(r);
      setPrivateAnchor(r);
      toast({
        title: r.anchor.onChain ? `Audit root anchored on-chain · seq ${r.anchor.sequence}` : r.anchor.error ?? "Audit root not anchored",
        tone: r.anchor.onChain ? "success" : "muted",
      });
    } catch (e) {
      setPrivateAuditError(friendlyError(e, "Couldn't anchor the private audit root."));
      toast({ title: friendlyError(e), tone: "danger" });
    } finally {
      setAnchoringPrivateAudit(false);
    }
  }

  function downloadPrivateAuditPacket() {
    if (!privateAudit) return;
    const blob = new Blob([JSON.stringify(privateAudit.packet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `benzo-private-audit-${privateAudit.packet.scope.label}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Page>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">Audit log</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            A tamper-evident double-entry record of every movement. Balances are derived from these; corrections are reversals, never edits.
          </p>
        </div>
      </div>

      <Card className="mb-5 p-5">
        <div className="flex items-center gap-2 text-[14px] font-semibold">
          <ScrollText size={16} className="text-primary" /> Tamper-evidence
        </div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
          Each entry's hash commits to the one before it. Re-walking the chain proves nobody edited, inserted, or deleted a record after the fact - the same guarantee an auditor would re-run themselves.
        </p>
        <div className="mt-4 flex items-center gap-3">
          {verifying ? (
            <Proving steps={["Reading the chain", "Re-hashing each entry", "Checking every link"]} />
          ) : (
            <Button onClick={verifyChain} data-testid="verify-chain">
              <ShieldAlert size={15} /> Verify chain
            </Button>
          )}
        </div>
        {integrity ? (
          <Reveal
            tone={integrity.ok ? "success" : "danger"}
            className={`mt-4 rounded-lg border px-4 py-3 ${integrity.ok ? "border-success/30 bg-success/8" : "border-danger/30 bg-danger/8"}`}
            data-testid="integrity-result"
          >
            <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${integrity.ok ? "text-[#1d7a52]" : "text-danger"}`}>
              {integrity.ok ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
              {integrity.ok ? `Chain intact · ${integrity.length} entries verified` : `Tampering detected at entry #${integrity.brokenAt}`}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {integrity.ok
                ? "Every entry's hash matches its recomputed value. Any after-the-fact change would break the chain from that point on."
                : "The recorded hash no longer matches the recomputed one. Everything from that entry onward is suspect."}
            </div>
          </Reveal>
        ) : null}
      </Card>

      <Card className="mb-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <FileKey2 size={16} className="text-primary" /> Private event packet
            </div>
            <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
              Ciphertext envelopes, Merkle inclusion proofs, and a chain head for invoice, payroll, payment, approval, and viewing-key events.
            </p>
          </div>
          <Button variant="outline" onClick={loadPrivateAuditPacket} loading={loadingPrivateAudit} data-testid="load-private-audit">
            <FileKey2 size={15} /> Load packet
          </Button>
        </div>
        {privateAuditError ? (
          <Reveal tone="danger" className="mt-4 rounded-lg border border-danger/30 bg-danger/8 px-4 py-3">
            <div className="text-[13px] font-semibold text-danger">{privateAuditError}</div>
          </Reveal>
        ) : null}
        {privateAudit ? (
          <Reveal tone={privateAudit.integrity.ok ? "success" : "danger"} className="mt-4 rounded-lg border border-border bg-surface/70 px-4 py-3" data-testid="private-audit-result">
            <div className="grid gap-3 md:grid-cols-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Events</div>
                <div className="font-display mt-1 text-xl text-fg">{privateAudit.packet.envelopes.length}</div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Merkle root</div>
                <div className="mt-1 font-mono text-[12px] text-fg">{formatAddress(privateAudit.packet.anchor.merkleRoot, 8, 8)}</div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Head hash</div>
                <div className="mt-1 font-mono text-[12px] text-fg">{formatAddress(privateAudit.packet.anchor.headHash, 8, 8)}</div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Integrity</div>
                <div className={`mt-1 flex items-center gap-1.5 text-[13px] font-semibold ${privateAudit.integrity.ok ? "text-[#1d7a52]" : "text-danger"}`}>
                  {privateAudit.integrity.ok ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
                  {privateAudit.integrity.ok ? "Verified" : `Broken at ${privateAudit.integrity.brokenAt}`}
                </div>
              </div>
            </div>
            {privateAnchor ? (
              <div className={`mt-4 rounded-lg border px-3 py-2.5 text-[12.5px] ${privateAnchor.anchor.onChain ? "border-success/30 bg-success/8" : "border-warning/30 bg-warning/10"}`} data-testid="private-audit-anchor-result">
                <div className={`flex items-center gap-1.5 font-semibold ${privateAnchor.anchor.onChain ? "text-[#1d7a52]" : "text-[#9a6b12]"}`}>
                  {privateAnchor.anchor.onChain ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
                  {privateAnchor.anchor.onChain ? `On-chain root anchor · sequence ${privateAnchor.anchor.sequence}` : "Root anchor unavailable"}
                </div>
                <div className="mt-1 break-all font-mono text-[11px] text-muted">
                  packet {formatAddress(privateAnchor.packetHash, 8, 8)}
                  {privateAnchor.anchor.contractId ? ` · contract ${formatAddress(privateAnchor.anchor.contractId, 6, 6)}` : ""}
                </div>
                {privateAnchor.anchor.explorer ? (
                  <a href={privateAnchor.anchor.explorer} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">
                    View root transaction <ExternalLink size={12} />
                  </a>
                ) : (
                  <div className="mt-2 text-[12px] text-muted">{privateAnchor.anchor.error}</div>
                )}
              </div>
            ) : null}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0 truncate text-[12px] text-muted">{privateAudit.disclosure}</div>
              <div className="flex flex-none items-center gap-2">
                <Button variant="outline" loading={anchoringPrivateAudit} onClick={anchorPrivateAuditRoot} disabled={privateAudit.packet.anchor.eventCount === 0} data-testid="anchor-private-audit">
                  <ShieldAlert size={15} /> Anchor root
                </Button>
                <Button variant="outline" onClick={downloadPrivateAuditPacket} data-testid="download-private-audit">
                  <Download size={15} /> Export JSON
                </Button>
              </div>
            </div>
          </Reveal>
        ) : null}
      </Card>

      {loadError && entries === null ? (
        <Card className="p-8 text-center">
          <div className="text-sm font-medium text-fg">{loadError}</div>
          <div className="mt-3">
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} data-testid="audit-retry">Try again</Button>
          </div>
        </Card>
      ) : entries === null ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex items-center gap-4 p-4">
              <Skeleton className="h-11 w-11 flex-none rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-5 w-20 flex-none" />
            </Card>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title="No entries yet" hint="Ledger entries appear here as soon as money moves: a shield, a payroll run, an invoice paid." />
      ) : (
        <Stagger className="space-y-4">
          {entries.map((e, i) => (
            <Stagger.Item key={e.id} index={i}>
              <Card className="flex items-center gap-4 p-4">
                <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ScrollText size={19} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Pill tone={sourceTone[e.sourceType] ?? "muted"}>{e.sourceType}</Pill>
                    <span className="truncate text-[12.5px] text-muted">{formatDate(e.postedAt)}</span>
                    {e.reversalOf ? <span className="text-[11.5px] font-semibold text-danger">reversal</span> : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted">
                    <span className="font-mono" title="audit hash (commits to the previous entry)">
                      {e.hash ? formatAddress(e.hash, 8, 6) : "-"}
                    </span>
                    {e.txId ? (
                      <a href={explorerTxUrl(e.txId)} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">
                        on-chain receipt
                      </a>
                    ) : null}
                  </div>
                </div>
                <div className="font-display tnum flex-none text-right text-[15px] text-fg">{fmtUsd(entryGross(e))}</div>
              </Card>
            </Stagger.Item>
          ))}
        </Stagger>
      )}
    </Page>
  );
}
