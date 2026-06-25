/**
 * Home — the single focal screen. One big balance (Helvetica Now, counts up), the
 * ambient Private chip, a 3-pill action row (Send is the purple+glow focal
 * action), and a plain-English activity preview. No tx hashes, gas, or "connect
 * wallet". A blocking banner appears only when the BFF isn't live.
 */
import { ArrowDownLeft, ArrowUpRight, Eye, Globe, Landmark, Lock, Plus, QrCode, Send as SendIcon, Smartphone } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useWallet } from "../lib/store";
import { fmtUsd } from "../lib/format";
import { Screen, Stagger } from "../ui/motion";
import { TopBar } from "../ui/chrome";
import { BalanceHero } from "../ui/money";
import { PrivateChip } from "../ui/privacy";
import { Card } from "../ui/primitives";
import { ActivityItem } from "../ui/ActivityItem";

function ActionPill({
  label,
  icon,
  primary,
  onClick,
  testid,
}: {
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      whileHover={{ y: -3 }}
      onClick={onClick}
      data-testid={testid}
      className={`flex flex-1 flex-col items-center gap-2 rounded-[22px] py-4 text-[13px] font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
        primary ? "bg-accent text-white shadow-[var(--shadow-glow)]" : "bg-card text-ink shadow-[0_6px_18px_rgba(25,40,55,0.05)]"
      }`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-full ${primary ? "bg-white/20" : "bg-canvas"}`}>{icon}</span>
      {label}
    </motion.button>
  );
}

/** A smaller pill action for the Public card (less weight than the focal row). */
function MiniAction({ label, icon, onClick, testid }: { label: string; icon: React.ReactNode; onClick: () => void; testid: string }) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      data-testid={testid}
      className="flex flex-1 flex-col items-center gap-1.5 rounded-2xl bg-canvas py-2.5 text-[11.5px] font-semibold text-ink transition outline-none hover:bg-canvas/70 focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-card text-ink/80">{icon}</span>
      <span className="text-center leading-tight">{label}</span>
    </motion.button>
  );
}

/**
 * The "Public" balance — plain liquid USDC anyone can pay to / you can send out.
 * Deliberately quieter than the Private hero: it's the everyday "outside world"
 * money, not the privacy-first default. Numbers stay tabular for clean alignment.
 */
function PublicBalanceCard({
  stroops,
  hidden,
  loading,
  onSend,
  onReceive,
  onMakePrivate,
}: {
  stroops: string;
  hidden: boolean;
  loading?: boolean;
  onSend: () => void;
  onReceive: () => void;
  onMakePrivate: () => void;
}) {
  return (
    <Card className="mt-4 p-4" data-testid="public-balance-card">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
            <Globe size={13} className="text-[#9a6b12]" /> Public balance
          </div>
          {loading ? (
            <div className="skeleton mt-1.5 h-7 w-24 rounded-lg" aria-label="Loading public balance" />
          ) : hidden ? (
            <div className="mt-0.5 font-display text-2xl tracking-tight text-ink/70" aria-label="Public balance hidden">••••</div>
          ) : (
            <div className="font-display tnum mt-0.5 text-2xl text-ink" data-testid="public-balance-amount">{fmtUsd(stroops)}</div>
          )}
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-[#fbf1dd] px-2 py-1 text-[10.5px] font-semibold text-[#9a6b12]">
          <Eye size={11} /> Visible
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-muted">Normal USDC. Send to or receive from any wallet.</p>

      <div className="mt-3 flex gap-2">
        <MiniAction label="Send to a wallet" testid="public-send" icon={<SendIcon size={15} />} onClick={onSend} />
        <MiniAction label="Receive" testid="public-receive" icon={<QrCode size={15} />} onClick={onReceive} />
        <MiniAction label="Make private" testid="public-make-private" icon={<Lock size={15} />} onClick={onMakePrivate} />
      </div>
    </Card>
  );
}

export function Home() {
  const nav = useNavigate();
  const { balance, publicBalance, history, loading, hidden, toggleHidden, session, deviceVerified } = useWallet();

  return (
    <Screen>
      <TopBar hidden={hidden} onToggleHide={toggleHidden} />

      {session && !session.live ? (
        <div className="mx-5 mb-1 rounded-xl bg-amber/12 px-3 py-2 text-[12px] font-medium text-[#9a6b12]" data-testid="chain-unavailable-banner">
          Live chain connection unavailable. Balance and money actions are blocked until the app reconnects.
        </div>
      ) : null}

      <Stagger className="px-5">
        {/* Balance hero — the focal card; canvas particles drift behind it */}
        <Stagger.Item index={0}>
          <Card className="relative overflow-hidden p-6">
            <button
              onClick={() => nav("/cash")}
              data-testid="add-money"
              className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-hair bg-card px-3 py-1.5 text-[13px] font-semibold text-muted transition outline-none hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Plus size={14} /> Add money
            </button>
            <div className="text-[13px] font-medium text-muted">Private balance</div>
            <BalanceHero stroops={balance?.stroops ?? "0"} hidden={hidden} loading={loading} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <PrivateChip label="Only you can see this" />
              {deviceVerified ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full bg-pos/10 px-2.5 py-1 text-[11.5px] font-semibold text-pos"
                  data-testid="device-verified"
                  title="Your balance was read and computed on this device, straight from the chain — no server."
                >
                  <Smartphone size={12} /> Read on your device
                </span>
              ) : null}
              {/* Move money out of Private → Public (so it can be sent to any wallet) */}
              <button
                onClick={() => nav("/convert?mode=public")}
                data-testid="home-make-public"
                className="inline-flex items-center gap-1 rounded-full border border-hair bg-card px-2.5 py-1 text-[11.5px] font-semibold text-muted transition outline-none hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Globe size={12} /> Make public
              </button>
            </div>
          </Card>
        </Stagger.Item>

        {/* Action row */}
        <Stagger.Item index={1}>
          <div className="mt-4 flex gap-2.5">
            <ActionPill label="Send" testid="action-send" primary icon={<ArrowUpRight size={18} />} onClick={() => nav("/send")} />
            <ActionPill label="Request" testid="action-request" icon={<ArrowDownLeft size={18} />} onClick={() => nav("/request")} />
            <ActionPill label="Cash out" testid="action-cashout" icon={<Landmark size={18} />} onClick={() => nav("/cash?tab=out")} />
          </div>
        </Stagger.Item>

        {/* Public balance — plain liquid USDC for the outside world */}
        <Stagger.Item index={2}>
          <PublicBalanceCard stroops={publicBalance?.stroops ?? "0"} hidden={hidden} loading={loading} onSend={() => nav("/send")} onReceive={() => nav("/deposit")} onMakePrivate={() => nav("/convert?mode=private")} />
        </Stagger.Item>

        {/* Activity preview */}
        <Stagger.Item index={3}>
          <Card className="mt-4 px-4 pb-2 pt-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[12px] font-bold uppercase tracking-[0.05em] text-muted">Recent</div>
              <button onClick={() => nav("/activity")} className="rounded text-[12px] font-semibold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40">
                See all
              </button>
            </div>
            {loading ? (
              <div className="space-y-3 py-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="skeleton h-[42px] w-[42px] rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <div className="skeleton h-3.5 w-28 rounded" />
                      <div className="skeleton h-3 w-20 rounded" />
                    </div>
                    <div className="skeleton h-4 w-14 rounded" />
                  </div>
                ))}
              </div>
            ) : history.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-7 text-center">
                <div className="text-sm font-semibold text-ink">Add money to get going</div>
                <div className="max-w-[240px] text-[13px] text-muted">
                  Once there's money in your wallet, your payments show up here — private to you.
                </div>
                <button
                  onClick={() => nav("/cash")}
                  data-testid="empty-add-money"
                  className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-white shadow-[var(--shadow-glow)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                >
                  <Plus size={14} /> Add money
                </button>
              </div>
            ) : (
              history.slice(0, 4).map((row, i, a) => <ActivityItem key={row.id} row={row} last={i === a.length - 1} />)
            )}
          </Card>
        </Stagger.Item>
        <div className="h-6" />
      </Stagger>
    </Screen>
  );
}
