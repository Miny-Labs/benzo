import { EyeOff, Loader2 } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "framer-motion";

export * from "./controls";

/** Surface card. */
export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-border bg-surface ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="font-display text-2xl text-fg">{title}</h1>
        {subtitle ? <p className="text-sm text-muted mt-1">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

type Tone = "muted" | "success" | "warning" | "danger" | "primary" | "shielded";
const TONE: Record<Tone, string> = {
  muted: "bg-border/60 text-muted",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/12 text-danger",
  primary: "bg-primary/10 text-primary",
  shielded: "bg-shielded/12 text-shielded",
};

export function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

/** Plain-English labels for internal status enums (web2 users don't speak "allowlisted"). */
const STATUS_LABEL: Record<string, string> = {
  allowlisted: "approved",
  pending_screening: "in review",
  needs_approval: "needs approval",
  processing: "sending",
  confirmed: "sent",
  settled: "sent",
};

/** Maps a money-movement / lifecycle status to a calm tone (red = failure only). */
export function StatusPill({ status }: { status: string }) {
  const tone: Tone =
    status === "confirmed" || status === "settled" || status === "completed" || status === "paid" || status === "active" || status === "allowlisted" || status === "connected" || status === "approved"
      ? "success"
      : status === "needs_approval" || status === "pending" || status === "pending_screening" || status === "proving" || status === "submitting" || status === "open" || status === "processing"
        ? "warning"
        : status === "failed" || status === "blocked" || status === "cancelled" || status === "expired" || status === "revoked" || status === "error" || status === "overdue"
          ? "danger"
          : "muted";
  return <Pill tone={tone}>{STATUS_LABEL[status] ?? status.replace(/_/g, " ")}</Pill>;
}

/** The one calm "private-by-default" indicator. */
export function ShieldedBadge({ label = "Private" }: { label?: string }) {
  return (
    <Pill tone="shielded">
      <EyeOff size={12} /> {label}
    </Pill>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  loading,
  type = "button",
  size = "md",
  className = "",
  title,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "outline";
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit";
  size?: "sm" | "md";
  className?: string;
  title?: string;
  /** pass-through for data-* / aria-* attributes (e.g. data-testid) */
  [key: `data-${string}`]: string | undefined;
}) {
  const variants: Record<string, string> = {
    primary: "bg-primary text-white hover:opacity-90",
    ghost: "bg-transparent text-fg hover:bg-border/50",
    danger: "bg-danger text-white hover:opacity-90",
    outline: "border border-border bg-transparent text-fg hover:bg-border/40",
  };
  const sizes = { sm: "px-2.5 py-1 text-xs", md: "px-3 py-1.5 text-sm" };
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      // calm, console-grade tactile feedback (reduced-motion: framer no-ops it)
      whileTap={disabled || loading ? undefined : { scale: 0.98 }}
      transition={{ type: "spring", stiffness: 380, damping: 30, mass: 0.7 }}
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[background-color,opacity,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : null}
      {children}
    </motion.button>
  );
}

/** Button that shows a spinner while `loading` (alias of Button for ergonomics). */
export const LoadingButton = Button;

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-fg tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="p-10 text-center">
      <div className="text-sm font-medium text-fg">{title}</div>
      {hint ? <div className="mt-1 text-sm text-muted">{hint}</div> : null}
    </Card>
  );
}
