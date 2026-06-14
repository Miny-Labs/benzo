/**
 * @benzo/links — one typed link format shared by every surface.
 *
 * Modeled on Daimo's daimoLink.ts: links are defined ONCE as a discriminated
 * union, encoded/parsed by this single package, and consumed by web / mobile /
 * extension / Telegram / CLI alike. Claim secrets live in the URL *fragment* so
 * they never reach a server log.
 */

export type BenzoLink = ClaimLink | RequestLink | HandleLink;

/** A tappable link that funds a fresh account from an embedded claim secret. */
export interface ClaimLink {
  type: "claim";
  /** claim secret — carried in the URL fragment, never sent to a server */
  secret: string;
  amount?: string;
  asset?: string;
}

/** A request to be paid (renders as a button / QR on any surface). */
export interface RequestLink {
  type: "request";
  /** @handle or G-address to pay */
  to: string;
  amount?: string;
  asset?: string;
  memo?: string;
  /** request id == on-chain commitment key (decimal U256), when registered */
  id?: string;
  /** deadline (unix seconds) */
  expiry?: string;
  /** external / merchant reference */
  reference?: string;
  /** bound request: the @handle/address expected to pay (omit = open invoice) */
  payer?: string;
}

/** A shareable pointer to a @handle. */
export interface HandleLink {
  type: "handle";
  handle: string;
}

export const SCHEME = "benzo:";
export const WEB_BASE = "https://benzo.app/l";

function prefix(base: "scheme" | "web"): string {
  return base === "web" ? `${WEB_BASE}/` : `${SCHEME}//`;
}

/** Encode a BenzoLink. Secrets are placed in the fragment. */
export function encodeBenzoLink(link: BenzoLink, base: "scheme" | "web" = "scheme"): string {
  const p = prefix(base);
  switch (link.type) {
    case "claim": {
      const q = new URLSearchParams();
      if (link.amount) q.set("amount", link.amount);
      if (link.asset) q.set("asset", link.asset);
      const qs = q.toString();
      return `${p}claim${qs ? "?" + qs : ""}#${link.secret}`;
    }
    case "request": {
      const q = new URLSearchParams();
      q.set("to", link.to);
      if (link.amount) q.set("amount", link.amount);
      if (link.asset) q.set("asset", link.asset);
      if (link.memo) q.set("memo", link.memo);
      if (link.id) q.set("id", link.id);
      if (link.expiry) q.set("expiry", link.expiry);
      if (link.reference) q.set("ref", link.reference);
      if (link.payer) q.set("payer", link.payer);
      return `${p}request?${q.toString()}`;
    }
    case "handle":
      return `${p}u/${encodeURIComponent(link.handle)}`;
  }
}

/** Parse a benzo:// or https://benzo.app/l link. Returns null if unrecognized. */
export function parseBenzoLink(input: string): BenzoLink | null {
  let rest = input.trim();
  let fragment = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }
  if (rest.startsWith(SCHEME)) rest = rest.slice(SCHEME.length).replace(/^\/\//, "");
  else if (rest.startsWith(WEB_BASE)) rest = rest.slice(WEB_BASE.length).replace(/^\//, "");
  else return null;

  const [pathPart, queryPart = ""] = rest.split("?");
  const q = new URLSearchParams(queryPart);
  const seg = pathPart.split("/").filter(Boolean);
  const kind = seg[0];

  if (kind === "claim") {
    if (!fragment) return null;
    const out: ClaimLink = { type: "claim", secret: fragment };
    const amount = q.get("amount");
    const asset = q.get("asset");
    if (amount) out.amount = amount;
    if (asset) out.asset = asset;
    return out;
  }
  if (kind === "request") {
    const to = q.get("to");
    if (!to) return null;
    const out: RequestLink = { type: "request", to };
    const amount = q.get("amount");
    const asset = q.get("asset");
    const memo = q.get("memo");
    const id = q.get("id");
    const expiry = q.get("expiry");
    const reference = q.get("ref");
    const payer = q.get("payer");
    if (amount) out.amount = amount;
    if (asset) out.asset = asset;
    if (memo) out.memo = memo;
    if (id) out.id = id;
    if (expiry) out.expiry = expiry;
    if (reference) out.reference = reference;
    if (payer) out.payer = payer;
    return out;
  }
  if (kind === "u") {
    const handle = decodeURIComponent(seg[1] ?? "");
    if (!handle) return null;
    return { type: "handle", handle };
  }
  return null;
}
