/**
 * Notifications (C8 - every competitor has this; our bell was dead). Fully
 * CLIENT-SIDE: the feed is DERIVED from the activity history already loaded in
 * the store (incoming payments, settles, cash-outs), and read-state lives in
 * localStorage. No server, no push infra - the chain + the device are the source.
 */
import type { ActivityRow } from "./api";
import { fmtUsd } from "./format";

export interface Notif {
  id: string;
  title: string;
  body: string;
  ts: number;
  kind: "in" | "out" | "info";
  read: boolean;
  /** true ONLY for a real on-chain-settled payment in live mode - drives the
   *  abstracted "proof verified" line. Never set for pending rows (honesty gate). */
  verified: boolean;
}

const LS_READ = "benzo.notif.read.v1";

function readSet(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(LS_READ) || "[]"));
  } catch {
    return new Set();
  }
}

function writeSet(s: Set<string>): void {
  try {
    localStorage.setItem(LS_READ, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

/** Turn one activity row into a human notification line. */
function lineFor(row: ActivityRow): { title: string; body: string; kind: Notif["kind"] } {
  const amt = fmtUsd(row.amount);
  if (row.status === "failed") {
    if (row.direction === "in") return { title: `${row.name} did not settle`, body: `${amt} failed`, kind: "info" };
    return { title: `Couldn't pay ${row.name}`, body: `${amt} was not settled`, kind: "info" };
  }
  if (row.type === "cashOut") {
    return { title: "Cash out", body: row.status === "settled" ? `${amt} returned to the testnet reserve` : `${amt} returning to the testnet reserve`, kind: "out" };
  }
  if (row.direction === "in") {
    return { title: `${row.name} paid you`, body: row.status === "settled" ? `+${amt}` : `+${amt} · ${row.status}`, kind: "in" };
  }
  return { title: `You paid ${row.name}`, body: row.status === "settled" ? `−${amt}` : `−${amt} · ${row.status}`, kind: "out" };
}

/** Derive the notification feed (newest first) from the activity history.
 *  `live` gates the abstracted "proof verified" line so it shows ONLY for real
 *  on-chain-settled payments - a strict honesty gate. */
export function deriveNotifications(history: ActivityRow[], opts: { live?: boolean } = {}): Notif[] {
  const read = readSet();
  return [...history]
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((row) => {
      const { title, body, kind } = lineFor(row);
      const verified = !!opts.live && row.status === "settled";
      return { id: row.id, title, body, ts: row.timestamp, kind, read: read.has(row.id), verified };
    });
}

export function unreadCount(history: ActivityRow[]): number {
  const read = readSet();
  return history.reduce((n, r) => (read.has(r.id) ? n : n + 1), 0);
}

export function markAllRead(history: ActivityRow[]): void {
  const s = readSet();
  for (const r of history) s.add(r.id);
  writeSet(s);
}

export function markRead(id: string): void {
  const s = readSet();
  s.add(id);
  writeSet(s);
}
