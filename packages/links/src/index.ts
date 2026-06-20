/**
 * @benzo/links — one typed link format shared by every surface.
 *
 * Modeled on Daimo's daimoLink.ts: links are defined ONCE as a discriminated
 * union, encoded/parsed by this single package, and consumed by web / mobile /
 * extension / Telegram / CLI alike. Claim secrets live in the URL *fragment* so
 * they never reach a server log.
 *
 * Every link carries an `app` scope ("consumer" | "business"). This is the
 * single source of truth for the two-app boundary: a consumer wallet must never
 * act on a business invite and vice-versa. The scope is enforced twice —
 * `assertAppScope()` here (UI/runtime) and, for claim links, by folding the
 * scope into the key-derivation domain separator in `@benzo/core` so a consumer
 * claim secret cannot even reconstruct a business account (and vice-versa).
 */

/** Which product a link belongs to. Absent on legacy links ⇒ treated as "consumer". */
export type AppScope = "consumer" | "business";

export type BenzoLink = ClaimLink | RequestLink | HandleLink | OrgInviteLink;

/** A tappable link that funds a fresh account from an embedded claim secret. */
export interface ClaimLink {
  type: "claim";
  /** claim secret — carried in the URL fragment, never sent to a server */
  secret: string;
  amount?: string;
  asset?: string;
  /** product scope (default "consumer" when absent) */
  app?: AppScope;
  /** expiry (unix seconds) — after this the sender may self-claim a refund */
  expiresAt?: string;
  /**
   * opaque, sealed sender context ("Maya sent you $25 — thanks!"). Encrypted
   * to the recipient with a key derived from the claim secret (see
   * sealLinkContext/openLinkContext); the server only ever sees ciphertext.
   */
  context?: string;
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
  /** product scope (default "consumer" when absent) */
  app?: AppScope;
}

/** A shareable pointer to a @handle. */
export interface HandleLink {
  type: "handle";
  handle: string;
  /** product scope (default "consumer" when absent) */
  app?: AppScope;
}

/**
 * A business invite — onboards an employee/contractor/customer into the correct
 * app. No money is attached (unlike a ClaimLink); a single-use HMAC token in the
 * fragment authorizes the seat/payee creation. Always `app: "business"`.
 */
export interface OrgInviteLink {
  type: "org";
  /** org being joined */
  orgId: string;
  /** what the invitee becomes */
  kind: "member" | "contractor" | "customer";
  /** single-use HMAC token — carried in the URL fragment */
  token: string;
  /** role granted (members only) */
  role?: string;
  /** display label for the inviting org (UI hint only, not authoritative) */
  orgName?: string;
  /** expiry (unix seconds) */
  expiresAt?: string;
  /** product scope — an org invite is always "business" */
  app?: AppScope;
}

export const SCHEME = "benzo:";
export const WEB_BASE = "https://benzo.app/l";

function prefix(base: "scheme" | "web"): string {
  return base === "web" ? `${WEB_BASE}/` : `${SCHEME}//`;
}

/** The effective scope of a link — legacy links with no tag are "consumer". */
export function linkApp(link: BenzoLink): AppScope {
  return link.app ?? (link.type === "org" ? "business" : "consumer");
}

/** Thrown when a link is opened in the wrong app. Carries both scopes for UX. */
export class WrongAppError extends Error {
  readonly name = "WrongAppError";
  constructor(
    readonly linkScope: AppScope,
    readonly expected: AppScope,
  ) {
    super(`This is a Benzo ${linkScope} link, opened in the Benzo ${expected} app.`);
  }
}

/**
 * Guard a link against the app consuming it. Throws WrongAppError on mismatch.
 * Call this BEFORE any action (claim, pay, onboard) so a business invite can
 * never be redeemed in the consumer wallet, or vice-versa.
 */
export function assertAppScope(link: BenzoLink, app: AppScope): void {
  const scope = linkApp(link);
  if (scope !== app) throw new WrongAppError(scope, app);
}

/** Encode a BenzoLink. Secrets/tokens are placed in the fragment. */
export function encodeBenzoLink(link: BenzoLink, base: "scheme" | "web" = "scheme"): string {
  const p = prefix(base);
  switch (link.type) {
    case "claim": {
      const q = new URLSearchParams();
      if (link.amount) q.set("amount", link.amount);
      if (link.asset) q.set("asset", link.asset);
      if (link.app) q.set("app", link.app);
      if (link.expiresAt) q.set("exp", link.expiresAt);
      if (link.context) q.set("c", link.context);
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
      if (link.app) q.set("app", link.app);
      return `${p}request?${q.toString()}`;
    }
    case "handle": {
      const q = new URLSearchParams();
      if (link.app) q.set("app", link.app);
      const qs = q.toString();
      return `${p}u/${encodeURIComponent(link.handle)}${qs ? "?" + qs : ""}`;
    }
    case "org": {
      const q = new URLSearchParams();
      q.set("o", link.orgId);
      q.set("kind", link.kind);
      if (link.role) q.set("r", link.role);
      if (link.orgName) q.set("org", link.orgName);
      q.set("app", link.app ?? "business");
      if (link.expiresAt) q.set("exp", link.expiresAt);
      return `${p}org?${q.toString()}#${link.token}`;
    }
  }
}

function parseApp(v: string | null): AppScope | undefined {
  return v === "consumer" || v === "business" ? v : undefined;
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
    const app = parseApp(q.get("app"));
    const exp = q.get("exp");
    const ctx = q.get("c");
    if (amount) out.amount = amount;
    if (asset) out.asset = asset;
    if (app) out.app = app;
    if (exp) out.expiresAt = exp;
    if (ctx) out.context = ctx;
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
    const app = parseApp(q.get("app"));
    if (amount) out.amount = amount;
    if (asset) out.asset = asset;
    if (memo) out.memo = memo;
    if (id) out.id = id;
    if (expiry) out.expiry = expiry;
    if (reference) out.reference = reference;
    if (payer) out.payer = payer;
    if (app) out.app = app;
    return out;
  }
  if (kind === "u") {
    const handle = decodeURIComponent(seg[1] ?? "");
    if (!handle) return null;
    const out: HandleLink = { type: "handle", handle };
    const app = parseApp(q.get("app"));
    if (app) out.app = app;
    return out;
  }
  if (kind === "org") {
    if (!fragment) return null; // token must be present
    const orgId = q.get("o");
    const kindParam = q.get("kind");
    if (!orgId || (kindParam !== "member" && kindParam !== "contractor" && kindParam !== "customer")) return null;
    const out: OrgInviteLink = { type: "org", orgId, kind: kindParam, token: fragment };
    const role = q.get("r");
    const orgName = q.get("org");
    const app = parseApp(q.get("app"));
    const exp = q.get("exp");
    if (role) out.role = role;
    if (orgName) out.orgName = orgName;
    out.app = app ?? "business";
    if (exp) out.expiresAt = exp;
    return out;
  }
  return null;
}
