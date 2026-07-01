/**
 * Form, overlay, and feedback primitives - the load-bearing building blocks every
 * real screen needs (forms, tables, modals, tabs, toasts, loading + the
 * privacy/settlement views that map to the SDK's SendHandle progress events).
 * Self-contained: only react + lucide. Re-exported through ./primitives.
 */
import {
  createContext, useCallback, useContext, useEffect, useId, useState,
  type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react";
import { Check, ChevronDown, Copy, Loader2, X, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { copyTextToClipboard } from "../lib/clipboard";

// ---------------------------------------------------------------- form fields

const fieldCls =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted " +
  "outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50";

export function Field({
  label, hint, error, htmlFor, children,
}: { label?: string; hint?: ReactNode; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <label htmlFor={htmlFor} className="text-sm font-medium text-fg">{label}</label> : null}
      {children}
      {error ? <span className="text-xs text-danger">{error}</span>
        : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

export function Input({ label, hint, error, ...props }:
  { label?: string; hint?: ReactNode; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const input = <input id={id} className={`${fieldCls} ${error ? "border-danger" : ""}`} {...props} />;
  return label || hint || error ? <Field label={label} hint={hint} error={error} htmlFor={id}>{input}</Field> : input;
}

export function Textarea({ label, hint, error, ...props }:
  { label?: string; hint?: ReactNode; error?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const el = <textarea id={id} className={`${fieldCls} min-h-[80px] ${error ? "border-danger" : ""}`} {...props} />;
  return label || hint || error ? <Field label={label} hint={hint} error={error} htmlFor={id}>{el}</Field> : el;
}

export function Select({ label, hint, error, children, ...props }:
  { label?: string; hint?: ReactNode; error?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  const el = (
    <div className="relative">
      <select id={id} className={`${fieldCls} appearance-none pr-9 ${error ? "border-danger" : ""}`} {...props}>
        {children}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
  return label || hint || error ? <Field label={label} hint={hint} error={error} htmlFor={id}>{el}</Field> : el;
}

export function Checkbox({ label, ...props }:
  { label?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <input type="checkbox" className="h-4 w-4 rounded border-border text-primary accent-[var(--color-primary)]" {...props} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- feedback

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-border/60 ${className}`} />;
}

// ---------------------------------------------------------------- modal/dialog

export function Modal({
  open, onClose, title, children, footer, width = "max-w-md",
}: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-fg/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative z-10 w-full ${width} rounded-[var(--radius-card)] border border-border bg-surface shadow-xl`}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="text-sm font-semibold text-fg">{title}</div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted outline-none transition hover:bg-border/50 focus-visible:ring-2 focus-visible:ring-primary/40" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- table

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className={`w-full border-collapse text-sm ${className}`}>{children}</table>
    </div>
  );
}
export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`bg-bg px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted ${className}`}>{children}</th>;
}
export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-t border-border px-4 py-2.5 text-fg ${className}`}>{children}</td>;
}
export function Tr({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <tr onClick={onClick} className={onClick ? "cursor-pointer hover:bg-border/30" : ""}>{children}</tr>;
}

// ---------------------------------------------------------------- tabs

export function Tabs<T extends string>({
  items, active, onChange,
}: { items: Array<{ id: T; label: ReactNode }>; active: T; onChange: (id: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-border">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-primary/40 ${
            active === t.id ? "border-primary text-fg" : "border-transparent text-muted hover:text-fg"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- toast

type Toast = { id: number; title: ReactNode; tone?: "success" | "danger" | "muted" | "warning" };
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export function useToast() { return useContext(ToastCtx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), 4000);
  }, []);
  const toneCls = { success: "border-success/40 text-success", danger: "border-danger/40 text-danger", muted: "border-border text-fg", warning: "border-warning/40 text-warning" };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className={`min-w-[220px] rounded-lg border bg-surface px-4 py-2.5 text-sm shadow-lg ${toneCls[t.tone ?? "muted"]}`}
            >
              {t.title}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- address + copy

export function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState<"idle" | "copied" | "blocked">("idle");
  return (
    <button
      type="button"
      onClick={() => {
        void copyTextToClipboard(value).then((ok) => setDone(ok ? "copied" : "blocked"));
        setTimeout(() => setDone("idle"), 1200);
      }}
      className="rounded p-1 text-muted outline-none transition hover:bg-border/50 focus-visible:ring-2 focus-visible:ring-primary/40"
      aria-label={done === "blocked" ? "Copy blocked" : done === "copied" ? "Copied" : "Copy"}
      title={done === "blocked" ? "Copy blocked. Select the value manually." : done === "copied" ? "Copied" : "Copy"}
    >
      {done === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} className={done === "blocked" ? "text-danger" : undefined} />}
    </button>
  );
}

export function AddressDisplay({ address, head = 4, tail = 4 }: { address: string; head?: number; tail?: number }) {
  const short = address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-fg">
      {short}<CopyButton value={address} />
    </span>
  );
}

// ---------------------------------------------------------------- timeline

export type StepStatus = "done" | "active" | "pending" | "failed";
/** Settlement / proving timeline - drive off SendHandle: pending → proving → settled. */
export function Timeline({ steps }: { steps: Array<{ label: ReactNode; status: StepStatus; hint?: ReactNode }> }) {
  const dot: Record<StepStatus, string> = {
    done: "bg-success border-success",
    active: "bg-warning border-warning animate-pulse",
    pending: "bg-transparent border-border",
    failed: "bg-danger border-danger",
  };
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className={`mt-0.5 h-3 w-3 flex-none rounded-full border-2 ${dot[s.status]}`} />
          <div className="text-sm">
            <div className={s.status === "pending" ? "text-muted" : "text-fg"}>{s.label}</div>
            {s.hint ? <div className="text-xs text-muted">{s.hint}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- privacy callout

/** What this transaction hides vs. proves - the private-by-default summary. */
export function PrivacyDisclosure({ hidden, proven }: { hidden: string[]; proven?: string[] }) {
  return (
    <div className="rounded-lg border border-shielded/30 bg-shielded/8 px-4 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-shielded">
        <ShieldCheck size={13} /> Private by default
      </div>
      <ul className="text-xs text-muted">
        {hidden.map((h) => <li key={h}>• <span className="text-fg">{h}</span> stays hidden</li>)}
        {(proven ?? []).map((p) => <li key={p}>• <span className="text-fg">{p}</span> verified privately</li>)}
      </ul>
    </div>
  );
}
