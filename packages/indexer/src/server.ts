/**
 * Minimal HTTP surface for the Benzo indexer (the viewing-key scan API the
 * SDK consumes). Stateless except for the in-memory index; restart re-syncs
 * from `startLedger`. For production this would persist a reorg-safe cursor;
 * for testnet/e2e the in-memory mirror is sufficient and fully real.
 *
 *   GET  /health
 *   GET  /commitments            -> [{leafIndex, commitment, mvkTag, txHash}]  (PUBLIC; client scans on-device)
 *   GET  /nullifier/:value       -> {spent: bool}                              (PUBLIC)
 *   POST /scan {viewingSecretHex} -> [...]   DEV ONLY (BENZO_INSECURE_INDEXER=1) — server-side decrypt, breaks privacy
 *   POST /audit {tvkSecretHex}   -> [...]    DEV ONLY (BENZO_INSECURE_INDEXER=1) — server-side decrypt, breaks privacy
 *
 * The PRIVATE path is GET /commitments + on-device scan (packages/core scanner.ts):
 * the viewing key never leaves the device. /scan + /audit exist only as a local
 * dev convenience and are disabled by default.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { BenzoIndexer, syncFromRpc } from "./index.js";

const PORT = Number(process.env.INDEXER_PORT ?? 8787);
const RPC = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const DEPLOY_PATH = process.env.BENZO_DEPLOYMENT ?? "deployments/testnet.json";

const dep = JSON.parse(readFileSync(DEPLOY_PATH, "utf8"));
const start = Number(process.env.INDEXER_START_LEDGER ?? 0);
const indexer = new BenzoIndexer(dep.treeLevels, start);

async function resync() {
  try {
    const n = await syncFromRpc(
      indexer,
      RPC,
      [dep.pool, dep.viewkeyAnchor],
      // Cold start scans from ledger 1 (full available history); if that has
      // aged out of the RPC retention window, the scanner restarts from the
      // oldest retained ledger. A durable cursor then resumes incrementally.
      indexer.cursorLedger || 1,
    );
    if (n) console.log(`[indexer] ingested ${n} events; cursor=${indexer.cursorLedger}`);
  } catch (e) {
    console.error("[indexer] resync error:", (e as Error).message);
  }
}


function json(res: import("node:http").ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  await resync();

  if (url.pathname === "/health") return json(res, 200, { ok: true, cursor: indexer.cursorLedger });

  if (url.pathname === "/commitments") {
    return json(
      res,
      200,
      indexer.commitments
        .filter(Boolean)
        .map((c) => ({ leafIndex: c.leafIndex, commitment: c.commitment, mvkTag: c.mvkTag, txHash: c.txHash })),
    );
  }

  if (url.pathname.startsWith("/nullifier/")) {
    const v = BigInt(url.pathname.split("/")[2]);
    return json(res, 200, { spent: indexer.isSpent(v) });
  }

  if (req.method === "POST" && (url.pathname === "/scan" || url.pathname === "/audit")) {
    // PRIVACY: these endpoints decrypt SERVER-SIDE with the caller's viewing/TVK
    // SECRET — the opposite of Benzo's model (the scanner should see only opaque
    // blobs; the client decrypts on-device). They exist only as a local dev/CLI
    // convenience and are DISABLED unless BENZO_INSECURE_INDEXER=1. The private
    // path is: pull public ciphertexts from GET /commitments and scan on-device
    // (packages/core scanner.ts) so the secret never leaves the device.
    if (process.env.BENZO_INSECURE_INDEXER !== "1") {
      return json(res, 403, {
        error:
          "server-side scan disabled: this would require sending your viewing secret to the server, which breaks the privacy model. Scan on-device over GET /commitments instead. Set BENZO_INSECURE_INDEXER=1 ONLY for local dev.",
      });
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (url.pathname === "/scan") {
      const secret = new Uint8Array(Buffer.from(body.viewingSecretHex, "hex"));
      return json(res, 200, indexer.scan(secret));
    }
    const tvk = new Uint8Array(Buffer.from(body.tvkSecretHex, "hex"));
    return json(res, 200, indexer.auditorScan(tvk));
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[indexer] listening on :${PORT}, rpc=${RPC}`);
  if (process.env.BENZO_INSECURE_INDEXER === "1") {
    console.warn("[indexer] ⚠️  BENZO_INSECURE_INDEXER=1 — /scan and /audit accept SECRETS over HTTP (server-side decrypt). DEV ONLY; never expose this.");
  }
});
