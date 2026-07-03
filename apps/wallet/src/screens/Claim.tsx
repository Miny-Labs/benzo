/**
 * Claim (P0-3) - redeem money sent to "no account". The link is parsed and its
 * app-scope is checked FIRST: a business invite opened here shows the Mismatch
 * screen (the two products never cross - enforced in the UI here AND in key
 * derivation). A valid consumer claim link shows the amount and claims it.
 *
 * The link is provided via `?link=<benzo url>` (the in-app deep-link path); the
 * claim secret lives in the link fragment and is sent to the local BFF to settle.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Briefcase, Building2, Check, Gift, X } from "lucide-react";
import { parseBenzoLink, assertAppScope, WrongAppError, type BenzoLink, type OrgInviteLink } from "@benzo/links";
import { api } from "../lib/api";
import { orgApi } from "../lib/orgApi";
import { friendlyError } from "../lib/errors";
import { useWallet } from "../lib/store";
import { fmtUsd } from "../lib/format";
import { findRequest, type RequestStatus } from "../lib/requests";
import { Screen } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { Button, SuccessCheck } from "../ui/primitives";

type Parsed = { ok: true; link: BenzoLink } | { ok: false; reason: "mismatch" | "broken"; scope?: string };

function parse(raw: string | null): Parsed {
  if (!raw) return { ok: false, reason: "broken" };
  const link = parseBenzoLink(raw);
  if (!link) return { ok: false, reason: "broken" };
  try {
    assertAppScope(link, "consumer");
  } catch (e) {
    if (e instanceof WrongAppError) return { ok: false, reason: "mismatch", scope: e.linkScope };
    return { ok: false, reason: "broken" };
  }
  return { ok: true, link };
}

function linkFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

import { claimLinkClientSide } from "../lib/benzoClient";

export function Claim() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const { refresh } = useWallet();
  const rawLink = useMemo(() => params.get("link") ?? linkFromHash(loc.hash), [params, loc.hash]);
  const parsed = useMemo(() => parse(rawLink), [rawLink]);
  const [phase, setPhase] = useState<"ready" | "claiming" | "done" | "error">("ready");
  const [amount, setAmount] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [checkingClaim, setCheckingClaim] = useState(false);
  const [claimUnavailable, setClaimUnavailable] = useState<"claimed" | "refunded" | "expired" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setClaimUnavailable(null);
    if (!parsed.ok || parsed.link.type !== "claim") {
      setCheckingClaim(false);
      return () => { cancelled = true; };
    }
    const link = parsed.link;
    const expiresAt = Number(link.expiresAt ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt && now >= expiresAt) {
      setClaimUnavailable("expired");
      setCheckingClaim(false);
      return () => { cancelled = true; };
    }
    setCheckingClaim(true);
    api.claimStatus(link.secret, link.amount, link.expiresAt)
      .then((status) => {
        if (cancelled) return;
        setClaimUnavailable(status.status === "open" ? null : status.status);
      })
      .catch(() => {
        if (!cancelled) setClaimUnavailable(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingClaim(false);
      });
    return () => { cancelled = true; };
  }, [parsed, rawLink]);

  if (!parsed.ok && parsed.reason === "mismatch") return <Mismatch scope={parsed.scope} />;
  if (!parsed.ok) {
    return (
      <Screen>
        <ScreenHeader title="Claim" />
        <Empty title="This link is broken or incomplete" hint="Ask the sender to share it again." />
      </Screen>
    );
  }

  const link = parsed.link;
  // A consumer-scoped org invite = a contractor/customer onboarding into the wallet.
  if (link.type === "org") return <ContractorInvite link={link} />;
  // A money request (C7) - the payer accepts / pays a different amount / declines.
  if (link.type === "request") return <PayRequest link={link} />;
  const claimAmount = link.type === "claim" ? link.amount : undefined;
  const secret = link.type === "claim" ? link.secret : "";

  if (checkingClaim) {
    return (
      <Screen>
        <ScreenHeader title="Claim" />
        <Empty title="Checking link" hint="Making sure this claim link is still open." />
      </Screen>
    );
  }

  if (claimUnavailable) {
    const copy = {
      claimed: { title: "This link was already claimed", hint: "No money moved. Ask the sender for a fresh link if needed." },
      refunded: { title: "This link was refunded", hint: "No money moved. Ask the sender to send a fresh link." },
      expired: { title: "This link expired", hint: "No money moved. Ask the sender to send a fresh link." },
    }[claimUnavailable];
    return (
      <Screen>
        <ScreenHeader title="Claim" />
        <Empty title={copy.title} hint={copy.hint} testId="claim-unavailable" />
      </Screen>
    );
  }

  async function doClaim() {
    setPhase("claiming");
    setErr(null);
    try {
      const r = await claimLinkClientSide(secret);
      if (!r) throw new Error("Could not claim link.");
      setAmount(r.amount);
      setPhase("done");
      void refresh();
    } catch (e) {
      setErr(friendlyError(e, "Couldn't claim this. The link may have already been used or expired."));
      setPhase("error");
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Claim" />
      <div className="flex flex-1 flex-col items-center justify-center px-7 pb-10 text-center">
        <AnimatePresence mode="wait">
          {phase === "done" ? (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-4">
              <SuccessCheck size={80} />
              <div className="font-display text-2xl" data-testid="claim-done">It's yours</div>
              <div className="text-[15px] text-muted">{fmtUsd(amount ?? claimAmount ?? "0")} is in your wallet</div>
              <Button className="mt-2" onClick={() => nav("/")}>Go to wallet <ArrowRight size={16} /></Button>
            </motion.div>
          ) : phase === "error" ? (
            <motion.div key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-danger/12 text-danger"><X size={28} /></div>
              <div className="font-display text-xl">Couldn't claim</div>
              <div className="max-w-[260px] text-sm text-muted" data-testid="claim-error">{err}</div>
              <Button variant="secondary" className="mt-2" onClick={() => setPhase("ready")}>Try again</Button>
            </motion.div>
          ) : (
            <motion.div key="ready" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-4">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/10 text-accent">
                <Gift size={36} />
              </div>
              <div>
                <div className="font-display text-3xl tnum">{claimAmount ? fmtUsd(claimAmount) : "Money"}</div>
                <div className="mt-1 text-[15px] text-muted">is waiting for you</div>
              </div>
              <p className="max-w-[280px] text-[13px] text-muted">Claim it into your private Benzo wallet. Only you'll be able to see it.</p>
              <Button full size="lg" className="mt-2" loading={phase === "claiming"} onClick={doClaim} data-testid="claim-accept">
                Claim {claimAmount ? fmtUsd(claimAmount) : ""}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Screen>
  );
}

/** Payer side of a money request (C7). Accept / pay-a-different-amount / decline.
 *  Settlement reuses the existing ZK transfer (Send); no new money path. */
import { listLocalHistory } from "../lib/history";

function PayRequest({ link }: { link: Extract<BenzoLink, { type: "request" }> }) {
  const nav = useNavigate();
  const [declined, setDeclined] = useState(false);
  const [checking, setChecking] = useState(true);
  const [unavailable, setUnavailable] = useState<RequestStatus | "missing" | null>(null);
  const requestId = link.id ?? "";
  const who = link.to || "Someone";
  const usd = link.amount ? String(Number(link.amount) / 1e7) : "";
  const q = (withAmount: boolean) => {
    const p = new URLSearchParams();
    if (link.to) p.set("to", link.to);
    if (withAmount && usd) p.set("amount", usd);
    if (link.memo) p.set("memo", link.memo);
    if (requestId) p.set("requestId", requestId);
    return `/send?${p.toString()}`;
  };

  useEffect(() => {
    let cancelled = false;
    if (!requestId) {
      setUnavailable("missing");
      setChecking(false);
      return () => { cancelled = true; };
    }
    const now = Math.floor(Date.now() / 1000);
    const expiry = Number(link.expiry ?? 0);
    if (expiry && now >= expiry) {
      setUnavailable("expired");
      setChecking(false);
      return () => { cancelled = true; };
    }
    
    // Check if we've already paid this request locally
    const history = listLocalHistory();
    const alreadyPaid = history.find((h) => {
      if (h.direction !== "out") return false;
      const memoMatch = link.memo && h.note.toLowerCase().includes(link.memo.toLowerCase());
      const idMatch = h.note.includes(requestId);
      return memoMatch || idMatch;
    });

    if (alreadyPaid) {
      setUnavailable("paid");
    } else {
      setUnavailable(null);
    }
    setChecking(false);
    return () => { cancelled = true; };
  }, [link.expiry, link.memo, requestId]);

  if (declined) {
    return (
      <Screen>
        <ScreenHeader title="Request" />
        <div className="flex flex-1 flex-col items-center justify-center px-7 pb-12 text-center" data-testid="request-declined">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink/[0.06] text-ink"><X size={26} /></div>
          <div className="font-display mt-4 text-xl">Request declined</div>
          <p className="mt-2 max-w-[280px] text-[14px] text-muted">No money moved. You can close this.</p>
          <Button variant="secondary" className="mt-5" onClick={() => nav("/")}>Back to wallet</Button>
        </div>
      </Screen>
    );
  }

  if (checking) {
    return (
      <Screen>
        <ScreenHeader title="Payment request" />
        <div className="flex flex-1 flex-col items-center justify-center px-7 pb-12 text-center" data-testid="request-checking">
          <div className="font-display text-xl">Checking request</div>
          <p className="mt-2 max-w-[280px] text-[14px] text-muted">Making sure this link is still open.</p>
        </div>
      </Screen>
    );
  }

  if (unavailable) {
    const copy: Record<RequestStatus | "missing", { title: string; hint: string }> = {
      pending: { title: "Checking request", hint: "Making sure this link is still open." },
      partially_paid: { title: "This request is partly paid", hint: "You can still pay the remaining amount." },
      paid: { title: "This request is already paid", hint: "No money moved. Ask the requester to send a fresh link if needed." },
      declined: { title: "This request was declined", hint: "No money moved." },
      expired: { title: "This request expired", hint: "No money moved. Ask the requester to send a fresh link." },
      cancelled: { title: "This request was cancelled", hint: "No money moved. Ask the requester to send a fresh link." },
      missing: { title: "This request could not be verified", hint: "No money moved. Ask the requester to send it again." },
    };
    const c = copy[unavailable];
    return (
      <Screen>
        <ScreenHeader title="Payment request" />
        <div className="flex flex-1 flex-col items-center justify-center px-7 pb-12 text-center" data-testid="request-unavailable">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink/[0.06] text-ink"><X size={26} /></div>
          <div className="font-display mt-4 text-xl">{c.title}</div>
          <p className="mt-2 max-w-[280px] text-[14px] text-muted">{c.hint}</p>
          <Button variant="secondary" className="mt-5" onClick={() => nav("/")}>Back to wallet</Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Payment request" />
      <div className="flex flex-1 flex-col items-center justify-center px-7 pb-10 text-center" data-testid="pay-request">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-accent"><ArrowRight size={28} /></div>
        <div className="mt-4">
          <div className="font-display text-3xl tnum">{link.amount ? fmtUsd(link.amount) : "Any amount"}</div>
          <div className="mt-1 text-[15px] text-muted">{who} requested {link.amount ? "this" : "a payment"}</div>
          {link.memo ? <div className="mt-1 text-[13px] text-muted">"{link.memo}"</div> : null}
        </div>
        <div className="mt-6 w-full max-w-[300px] space-y-2.5">
          <Button full size="lg" onClick={() => nav(q(true))} data-testid="request-pay">
            Pay {link.amount ? fmtUsd(link.amount) : ""}
          </Button>
          <Button full variant="secondary" onClick={() => nav(q(false))} data-testid="request-pay-other">
            Pay a different amount
          </Button>
          <button onClick={() => setDeclined(true)} className="w-full rounded-lg py-2 text-[14px] font-semibold text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="request-decline">
            Decline
          </button>
        </div>
        <p className="mt-5 max-w-[290px] text-[12px] leading-relaxed text-muted">
          Only pay a request from someone you recognize. Benzo will never ask you to pay through a link you didn't expect.
        </p>
      </div>
    </Screen>
  );
}

/** A contractor/customer accepting a business invite - onboards in THIS wallet. */
function realWalletHandle(handle?: string): string | undefined {
  const normalized = handle?.trim();
  if (!normalized) return undefined;
  const bare = normalized.replace(/^@/, "").toLowerCase();
  if (!bare || bare === "you") return undefined;
  return normalized.startsWith("@") ? normalized : `@${normalized}`;
}

import { getLocalAccountSummary } from "../lib/localWallet";

function ContractorInvite({ link }: { link: OrgInviteLink }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const org = link.orgName ?? "A company";

  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      const summary = getLocalAccountSummary();
      const handle = summary?.address;
      if (!handle) throw new Error("Initialize your wallet before accepting this invite.");
      const r = await orgApi.acceptInvite({
        token: link.token,
        handle,
        counterpartyId: link.counterpartyId,
        kind: link.kind,
        orgId: link.orgId,
        name: link.inviteeName,
      });
      nav(`/work?cp=${encodeURIComponent(r.counterpartyId ?? "")}&org=${encodeURIComponent(r.orgName ?? org)}&token=${encodeURIComponent(link.token)}`);
    } catch (e) {
      setErr(friendlyError(e, "Couldn't accept the invite. The link may have expired - ask the company to resend it."));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Invite" />
      <div className="flex flex-1 flex-col items-center justify-center px-7 pb-12 text-center" data-testid="contractor-invite">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/10 text-accent">
          <Briefcase size={34} />
        </div>
        <div className="font-display mt-4 text-2xl">{org} invited you</div>
        <p className="mt-2 max-w-[300px] text-[14px] text-muted">
          Bill them as a {link.kind}. You get paid privately to this wallet, and your account stays entirely yours.
        </p>
        {err ? <p className="mt-3 max-w-[280px] text-[13px] text-danger" data-testid="contractor-error">{err}</p> : null}
        <Button full size="lg" className="mt-6" loading={busy} onClick={accept} data-testid="contractor-accept">
          Accept & start billing <ArrowRight size={16} />
        </Button>
      </div>
    </Screen>
  );
}

/** Shown when a business invite is opened in the consumer wallet. */
function Mismatch({ scope }: { scope?: string }) {
  return (
    <Screen>
      <ScreenHeader title="Wrong app" />
      <div className="flex flex-1 flex-col items-center justify-center px-7 pb-12 text-center" data-testid="claim-mismatch">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink/[0.06] text-ink">
          <Building2 size={28} />
        </div>
        <div className="font-display mt-4 text-2xl">This is a Benzo Business invite</div>
        <p className="mt-2 max-w-[300px] text-[14px] text-muted">
          {scope === "business" ? "Open it in Benzo for Business" : "Open it in the right Benzo app"}. Your personal wallet and your work
          account stay completely separate.
        </p>
        <a
          href={((import.meta as { env?: Record<string, string> }).env?.VITE_CONSOLE_ORIGIN) || "http://localhost:5174"}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-3 text-[15px] font-semibold text-white shadow-[var(--shadow-glow)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          Open Benzo for Business <ArrowRight size={16} />
        </a>
      </div>
    </Screen>
  );
}

function Empty({ title, hint, testId }: { title: string; hint: string; testId?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-7 pb-12 text-center" data-testid={testId}>
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ink/[0.06] text-ink"><X size={26} /></div>
      <div className="font-display mt-4 text-xl">{title}</div>
      <p className="mt-2 max-w-[280px] text-[14px] text-muted">{hint}</p>
    </div>
  );
}
