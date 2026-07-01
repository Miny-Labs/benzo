/**
 * One activity row - avatar, plain-English line, signed amount, and a soft status
 * pill for in-flight states (Arriving / Proving). No tx hashes, no chain words.
 */
import { motion } from "framer-motion";
import { ArrowDownLeft, ChevronRight, Landmark } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ActivityRow } from "../lib/api";
import { relativeTime } from "../lib/format";
import { AmountText } from "./money";
import { Avatar } from "./primitives";

const STATUS_PILL: Record<string, { label: string; cls: string } | undefined> = {
  arriving: { label: "Arriving · ~2 min", cls: "text-amber bg-amber/12" },
  proving: { label: "Sending…", cls: "text-accent bg-accent/10" },
  pending: { label: "Pending", cls: "text-amber bg-amber/12" },
  failed: { label: "Failed", cls: "text-danger bg-danger/12" },
};

export function ActivityItem({ row, last }: { row: ActivityRow; last?: boolean }) {
  const nav = useNavigate();
  const isCash = row.type === "cashOut" || row.type === "unshield" || row.type === "shield" || row.type === "cashIn";
  const pill = STATUS_PILL[row.status];
  const amountDirection = row.status === "failed" ? undefined : row.direction;
  return (
    <motion.button
      type="button"
      onClick={() => nav(`/activity/${row.id}`)}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileTap={{ scale: 0.985 }}
      className={`group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-left transition hover:bg-canvas/60 ${last ? "" : "border-b border-hair"}`}
      data-testid="activity-row"
    >
      {isCash ? (
        <div className={`flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full ${row.direction === "in" ? "bg-[#e7e0fb] text-[#4a2fa0]" : "bg-[#fbf1dd] text-[#9a6b12]"}`}>
          {row.direction === "in" ? <ArrowDownLeft size={18} /> : <Landmark size={18} />}
        </div>
      ) : (
        <Avatar name={row.name} tone={row.tone} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{row.name}</span>
          {row.unverified ? (
            <span className="flex-none rounded-full bg-muted/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted" title="Not verified on-chain">Unverified</span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted">{row.note}</div>
        {pill ? (
          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${pill.cls}`}>{pill.label}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <div className="flex flex-col items-end">
          <AmountText stroops={row.amount} direction={amountDirection} className="text-base" />
          <span className="mt-0.5 text-xs text-muted">{relativeTime(row.timestamp)}</span>
        </div>
        <ChevronRight size={15} className="flex-none text-hair transition group-hover:text-muted" />
      </div>
    </motion.button>
  );
}
