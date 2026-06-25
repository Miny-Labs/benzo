/**
 * Display formatting for money, addresses, dates, and explorer links.
 * Amounts are minor units (USDC = 7 decimals on Stellar) as string|bigint.
 */
import { NETWORK } from "./network";

/** "12345670000" (7dp) -> "1,234.567" (trailing zeros trimmed, min 2 decimals). */
export function formatMoney(minor: string | bigint, decimals = 7, code = "USDC"): string {
  let n: bigint;
  try { n = typeof minor === "bigint" ? minor : BigInt(minor || "0"); } catch { return String(minor); }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}${code ? ` ${code}` : ""}`;
}

/** "$842,300.00" — dollar-prefixed, fixed 2 decimals (the dashboard headline form). */
export function fmtUsd(minor: string | bigint, decimals = 7): string {
  let n: bigint;
  try {
    n = typeof minor === "bigint" ? minor : BigInt(minor || "0");
  } catch {
    return String(minor);
  }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % base).toString().padStart(decimals, "0").slice(0, 2);
  return `${neg ? "-" : ""}$${whole}.${cents}`;
}

/** "GABC…WXYZ" — truncate a Stellar address / hash for display. */
export function formatAddress(addr: string, head = 4, tail = 4): string {
  if (!addr) return "";
  return addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function formatDate(ts: number | string | Date): string {
  const d = ts instanceof Date ? ts : new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Default to the build's active network (NETWORK), never a hardcoded "testnet":
// these links are the real settlement receipts, so on a mainnet/public build they
// must deep-link to the right explorer (a testnet default => "tx not found" => the
// payment looks unverified). A caller can still pass an explicit network when it has one
// (e.g. the on-chain ref's own network field).
export function explorerTxUrl(hash: string, network: string = NETWORK): string {
  return `https://stellar.expert/explorer/${network}/tx/${hash}`;
}

export function explorerContractUrl(id: string, network: string = NETWORK): string {
  return `https://stellar.expert/explorer/${network}/contract/${id}`;
}

/**
 * Turn a thrown error into operator-facing copy. Surfaces the useful operational
 * messages (handle/balance/approval/amount/funding/network) verbatim; genericizes
 * anything that reads technical (stack traces, JSON-RPC noise, fetch failures), and
 * logs the raw error for debugging. Mirrors the friendly pattern already in Pay.tsx.
 */
export function friendlyError(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!raw) return fallback;
  // eslint-disable-next-line no-console
  console.error(e);
  if (/network|offline|fetch|timeout|connection|failed to fetch/i.test(raw)) {
    return "Network problem. Check your connection and try again.";
  }
  // operationally useful, human-readable errors pass through
  if (/handle|balance|approv|amount|fund|cap|threshold|quorum|expired|permission|not found|invalid/i.test(raw)) {
    return raw;
  }
  // looks like a raw technical message (stack/JSON/long token) → genericize
  if (raw.length > 140 || /[{}<>]|0x[0-9a-f]{6,}|\bat\s+\w+\.|Error:/i.test(raw)) {
    return fallback;
  }
  return raw;
}
