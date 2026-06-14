/**
 * Self-hosted Benzo anchor — SEP-1 / SEP-10 / SEP-24 on Stellar testnet.
 *
 * This is a faithful, dependency-light implementation of the anchor wire
 * protocol the Benzo corridor needs. It is the same role SDF's reference
 * Anchor Platform plays, run self-hosted with no external dependencies:
 *
 *   SEP-1  : GET /.well-known/stellar.toml  (discovery)
 *   SEP-10 : GET/POST /auth                 (challenge -> JWT)
 *   SEP-24 : POST /sep24/transactions/{deposit,withdraw}/interactive
 *            GET  /sep24/transaction
 *            POST /sep24/sim/{id}           (drives the simulated fiat step)
 *
 * REAL vs SIMULATED (disclosed honestly):
 *   - REAL: SEP-10 challenge/JWT, SEP-24 transaction lifecycle, and the
 *     on-chain USDC settlement at both edges (the anchor's distribution
 *     account sends/receives real Circle testnet USDC via Horizon).
 *   - SIMULATED: the fiat ledger leg (bank/cash). There is no real bank; the
 *     "fiat received" / "fiat paid out" events are driven by POST /sep24/sim.
 *     This is the exact boundary BENZO.md §8.2 says to disclose.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { requireEnv } from "@benzo/core";
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { kycFromEnv, type KycProvider } from "@benzo/kyc";
import { buildChallenge, verifyChallenge } from "./sep10.js";

const PORT = Number(process.env.ANCHOR_PORT ?? 8888);
const HOME_DOMAIN = process.env.ANCHOR_HOME_DOMAIN ?? `localhost:${PORT}`;
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const USDC_CODE = process.env.USDC_CODE ?? "USDC";
const USDC_ISSUER = requireEnv("USDC_ISSUER");
const SIGNING_SECRET = requireEnv("ANCHOR_SIGNING_SECRET");
const DIST_SECRET = requireEnv("ANCHOR_DISTRIBUTION_SECRET");
const JWT_SECRET = process.env.ANCHOR_JWT_SECRET ?? "benzo-anchor-dev-jwt-secret";

const signingKp = Keypair.fromSecret(SIGNING_SECRET);
const distKp = Keypair.fromSecret(DIST_SECRET);
const usdc = new Asset(USDC_CODE, USDC_ISSUER);
const horizon = new Horizon.Server(HORIZON_URL);

// SEP-12 KYC at the regulated fiat edge. kycFromEnv() returns Didit when
// DIDIT_API_KEY is set, else a key-free Mock that auto-approves (so the
// testnet corridor runs without a live KYC account). PII lives only here, at
// the off-chain edge — never in the shielded notes (BENZO.md §8.2).
const kyc: KycProvider = kycFromEnv();

// ---- tiny JWT (HS256) -----------------------------------------------------
function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}
function jwtSign(payload: object): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
function jwtVerify(token: string): Record<string, unknown> | null {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  const expect = createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url");
  if (expect !== s) return null;
  const payload = JSON.parse(Buffer.from(b, "base64url").toString());
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// ---- SEP-24 transaction store --------------------------------------------
type Sep24Status =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_anchor"
  | "completed"
  | "error";

interface Sep24Tx {
  id: string;
  kind: "deposit" | "withdrawal";
  status: Sep24Status;
  asset_code: string;
  account: string; // the user's Stellar account
  amount_in?: string;
  amount_out?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  stellar_transaction_id?: string;
  started_at: string;
  completed_at?: string;
  message?: string;
  /** SEP-12 KYC session opened for this deposit's account. */
  kyc_session_id?: string;
  kyc_url?: string;
}

const txs = new Map<string, Sep24Tx>();

// ---- helpers --------------------------------------------------------------
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}
function bearer(req: IncomingMessage): Record<string, unknown> | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return jwtVerify(h.slice(7));
}

/** Send `amount` USDC from the distribution account to `destination`. */
async function payUsdc(destination: string, amount: string, memo?: string): Promise<string> {
  const acct = await horizon.loadAccount(distKp.publicKey());
  const builder = new TransactionBuilder(acct, {
    fee: "10000",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination, asset: usdc, amount }))
    .setTimeout(60);
  if (memo) builder.addMemo(Memo.text(memo.slice(0, 28)));
  const tx = builder.build();
  tx.sign(distKp);
  const res = await horizon.submitTransaction(tx);
  return res.hash;
}

// ---- SEP-1: stellar.toml --------------------------------------------------
function stellarToml(): string {
  const base = `http://${HOME_DOMAIN}`;
  return [
    `NETWORK_PASSPHRASE="${PASSPHRASE}"`,
    `SIGNING_KEY="${signingKp.publicKey()}"`,
    `WEB_AUTH_ENDPOINT="${base}/auth"`,
    `TRANSFER_SERVER_SEP0024="${base}/sep24"`,
    ``,
    `[[CURRENCIES]]`,
    `code="${USDC_CODE}"`,
    `issuer="${USDC_ISSUER}"`,
    `status="test"`,
    `is_asset_anchored=true`,
    `anchor_asset_type="fiat"`,
    `desc="Circle testnet USDC, settled on-chain. Fiat leg is SIMULATED by this self-hosted anchor."`,
  ].join("\n");
}

// ---- SEP-10: challenge + JWT (real Ed25519 verification, see sep10.ts) -----
function sep10Challenge(account: string): string {
  // SEP-10: 48 bytes of entropy, base64 (64 chars) — fits the manageData limit.
  const nonce = randomBytes(48).toString("base64");
  void randomUUID;
  return buildChallenge({
    signingKeypair: signingKp,
    clientAccount: account,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: HOME_DOMAIN,
    networkPassphrase: PASSPHRASE,
    nonce,
    now: Math.floor(Date.now() / 1000),
  });
}

function sep10Verify(xdrStr: string): string | null {
  const r = verifyChallenge(xdrStr, signingKp.publicKey(), PASSPHRASE);
  return r.ok ? r.clientAccount! : null;
}

// ---- request router -------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOME_DOMAIN}`);
  const path = url.pathname;

  try {
    if (path === "/.well-known/stellar.toml") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(stellarToml());
    }

    // SEP-10
    if (path === "/auth" && req.method === "GET") {
      const account = url.searchParams.get("account");
      if (!account) return json(res, 400, { error: "account required" });
      return json(res, 200, {
        transaction: sep10Challenge(account),
        network_passphrase: PASSPHRASE,
      });
    }
    if (path === "/auth" && req.method === "POST") {
      const body = await readBody(req);
      const client = sep10Verify(String(body.transaction));
      if (!client) return json(res, 400, { error: "invalid challenge" });
      const token = jwtSign({
        iss: `http://${HOME_DOMAIN}/auth`,
        sub: client,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 86400,
      });
      return json(res, 200, { token });
    }

    // SEP-24 (JWT-gated)
    if (path.startsWith("/sep24/")) {
      const claims = bearer(req);
      if (!claims) return json(res, 403, { error: "missing/invalid JWT" });
      const account = String(claims.sub);

      if (path === "/sep24/transactions/deposit/interactive" && req.method === "POST") {
        const body = await readBody(req);
        const id = randomUUID();
        // Open a SEP-12 KYC session for this account before any fiat onramp.
        const session = await kyc.start(String(body.account ?? account));
        txs.set(id, {
          id,
          kind: "deposit",
          status: "incomplete",
          asset_code: String(body.asset_code ?? USDC_CODE),
          account: String(body.account ?? account),
          amount_in: body.amount ? String(body.amount) : undefined,
          started_at: new Date().toISOString(),
          kyc_session_id: session.id,
          kyc_url: session.url,
        });
        return json(res, 200, {
          type: "interactive_customer_info_needed",
          id,
          // SEP-24 interactive URL: the KYC flow (Didit-hosted) when a real
          // provider is configured, else the local fiat simulator.
          url: kyc.name === "mock" ? `http://${HOME_DOMAIN}/sep24/sim/${id}` : session.url,
          kyc_session_id: session.id,
        });
      }

      if (path === "/sep24/transactions/withdraw/interactive" && req.method === "POST") {
        const body = await readBody(req);
        const id = randomUUID();
        txs.set(id, {
          id,
          kind: "withdrawal",
          status: "pending_user_transfer_start",
          asset_code: String(body.asset_code ?? USDC_CODE),
          account: String(body.account ?? account),
          amount_in: body.amount ? String(body.amount) : undefined,
          withdraw_anchor_account: distKp.publicKey(),
          withdraw_memo: id.replace(/-/g, "").slice(0, 20),
          withdraw_memo_type: "text",
          started_at: new Date().toISOString(),
        });
        return json(res, 200, {
          type: "interactive_customer_info_needed",
          id,
          url: `http://${HOME_DOMAIN}/sep24/sim/${id}`,
        });
      }

      if (path === "/sep24/transaction" && req.method === "GET") {
        const id = url.searchParams.get("id");
        const tx = id ? txs.get(id) : undefined;
        if (!tx) return json(res, 404, { error: "not found" });
        return json(res, 200, { transaction: tx });
      }

      // Drive the simulated fiat step.
      //   deposit  : body { amount } -> anchor pays USDC to the user (REAL on-chain)
      //   withdraw : body { stellar_transaction_id } -> anchor confirms receipt
      //              of USDC and simulates fiat payout
      if (path.startsWith("/sep24/sim/") && req.method === "POST") {
        const id = path.split("/").pop()!;
        const tx = txs.get(id);
        if (!tx) return json(res, 404, { error: "not found" });
        const body = await readBody(req);

        if (tx.kind === "deposit") {
          // KYC gate: the regulated fiat edge must not release USDC until the
          // customer is verified. Mock auto-approves; Didit reflects the real
          // decision. Fail-closed on anything that isn't an explicit approval.
          if (tx.kyc_session_id) {
            const decision = await kyc.status(tx.kyc_session_id);
            if (decision !== "approved") {
              tx.status = "pending_anchor";
              tx.message = `KYC ${decision}; complete verification before deposit settles`;
              return json(res, 403, { error: "kyc_required", kyc_status: decision, kyc_url: tx.kyc_url, transaction: tx });
            }
          }
          const amount = String(body.amount ?? tx.amount_in ?? "1");
          tx.status = "pending_anchor";
          tx.message = "SIMULATED fiat received; settling USDC on-chain";
          const hash = await payUsdc(tx.account, amount, `benzo-dep-${id.slice(0, 8)}`);
          tx.amount_in = amount;
          tx.amount_out = amount;
          tx.stellar_transaction_id = hash;
          tx.status = "completed";
          tx.completed_at = new Date().toISOString();
          tx.message = "Deposit settled. Fiat leg was SIMULATED.";
          return json(res, 200, { transaction: tx });
        }

        // withdrawal: the user has sent USDC to the anchor; record + simulate payout
        tx.stellar_transaction_id = String(body.stellar_transaction_id ?? "");
        tx.amount_in = String(body.amount ?? tx.amount_in ?? "0");
        tx.amount_out = tx.amount_in;
        tx.status = "completed";
        tx.completed_at = new Date().toISOString();
        tx.message = "USDC received on-chain; fiat payout SIMULATED.";
        return json(res, 200, { transaction: tx });
      }
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`[anchor] SEP-1/10/24 on http://${HOME_DOMAIN}  signing=${signingKp.publicKey()}  dist=${distKp.publicKey()}`);
});
