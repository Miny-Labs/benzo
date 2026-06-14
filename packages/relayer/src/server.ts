/**
 * @benzo/relayer HTTP service — the one server the wallet needs.
 *
 * Two endpoints, both self-hosted, both liveness-only (never custody):
 *   POST /sponsor/onboard  → co-sign a 0-XLM account + USDC trustline for a
 *                            browser-generated key (the wallet adds its own
 *                            signature and submits — non-custodial).
 *   POST /relay            → submit a proven `transfer` (gasless): the relayer
 *                            pays the XLM fee; the self-authorizing proof means
 *                            it cannot alter the transfer.
 *
 * Run: `pnpm --filter @benzo/relayer serve` (after `set -a; . ./.env; set +a`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StellarCli, configFromEnv, prepareSponsoredOnboard, requireEnv } from "@benzo/core";

const PORT = Number(process.env.RELAYER_PORT ?? 8788);
const RELAYER_SOURCE = process.env.RELAYER_SOURCE ?? "benzo-relayer";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";

const cli = new StellarCli(configFromEnv());

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function send(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (req.url === "/health") return send(res, 200, { ok: true });

    if (req.url === "/sponsor/onboard" && req.method === "POST") {
      const { newAccountPublic } = await readJson(req);
      if (typeof newAccountPublic !== "string") {
        return send(res, 400, { error: "newAccountPublic (string) required" });
      }
      const out = await prepareSponsoredOnboard({
        horizonUrl: HORIZON_URL,
        networkPassphrase: requireEnv("NETWORK_PASSPHRASE"),
        sponsorSecret: requireEnv("DEPLOYER_SECRET"),
        asset: { code: requireEnv("USDC_CODE"), issuer: requireEnv("USDC_ISSUER") },
        newAccountPublic,
      });
      return send(res, 200, out);
    }

    if (req.url === "/relay" && req.method === "POST") {
      const { contractId, fnArgs } = await readJson(req);
      if (typeof contractId !== "string" || !Array.isArray(fnArgs)) {
        return send(res, 400, { error: "contractId + fnArgs required" });
      }
      // Liveness-only: the relayer submits ONLY a proven `transfer`. The proof
      // fixes nullifiers/commitments/fee/relayer, so it cannot be altered.
      if (fnArgs[0] !== "transfer") {
        return send(res, 403, { error: "relayer only submits `transfer`" });
      }
      const r = await cli.invoke({
        contractId,
        source: RELAYER_SOURCE,
        send: true,
        fnArgs: fnArgs as string[],
      });
      return send(res, 200, { result: r.result, txHash: r.txHash, raw: r.raw });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String((e as Error)?.message ?? e) });
  }
});

server.listen(PORT, () => {
  console.error(`[benzo-relayer] listening on :${PORT} (relayer source: ${RELAYER_SOURCE})`);
});
