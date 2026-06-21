/**
 * Benzo confidential prover — HTTP service that runs INSIDE a Phala dstack
 * (Intel TDX) CVM.
 *
 *   GET  /health            → liveness + the circuits this enclave can prove
 *   GET  /info              → dstack app info (app_id, compose_hash, instance_id)
 *   GET  /quote?nonce=<hex> → a fresh TDX attestation quote whose report_data is
 *                             (enclaveX25519Pub ‖ clientNonce); the client verifies
 *                             this quote off-enclave BEFORE sending any witness.
 *   POST /prove             → { circuit, input }  (plaintext) OR
 *                             { circuit, enc:{epk,iv,ct,tag} }  (witness sealed to
 *                             the attested enclave key). Returns the raw snarkjs
 *                             { proof, publicSignals }; the client re-encodes for
 *                             Soroban so a bad enclave can't forge the on-chain bytes.
 *
 * The witness is decrypted ONLY inside this enclave; soundness is unaffected
 * (proofs are verified on-chain), so a compromised enclave can at worst see a
 * witness it was sealed — never mint or double-spend.
 */
import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { DstackClient } from "@phala/dstack-sdk";
import { CIRCUITS, proveCircuit, assertArtifacts } from "./prove.mjs";
import { genEnclaveKeypair, decryptWitness } from "./ecies.mjs";
import { contributeCircuit, ceremonyReportData } from "./contribute.mjs";

const ARTIFACT_ROOT = process.env.BENZO_ARTIFACT_ROOT || join(import.meta.dirname, "..", "artifacts");

const PORT = Number(process.env.BENZO_PROVER_PORT || 8080);

// Fail fast at boot if any bundled artifact is missing.
assertArtifacts();

// dstack guest-agent client — lazily constructed (the socket only exists inside
// a CVM), so /prove still runs anywhere for local validation; /quote needs it.
let _dstack;
const getDstack = () => (_dstack ??= new DstackClient());

// Ephemeral X25519 keypair for sealed witness transport (per boot).
const ENC = genEnclaveKeypair();
console.log(`[prover] enclave x25519 pub: ${ENC.rawPub.toString("hex")}`);
console.log(`[prover] circuits: ${CIRCUITS.join(", ")}`);

// CORS — a browser / mobile-web / extension must be able to fetch /quote and
// /prove cross-origin. No credentials are used, so a permissive origin is safe.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...CORS });
  res.end(body);
};

const readBody = (req, limit = 64 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    // CORS preflight.
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, circuits: CIRCUITS, encPub: ENC.rawPub.toString("hex") });
    }

    if (req.method === "GET" && url.pathname === "/info") {
      const info = await getDstack().info();
      return send(res, 200, info);
    }

    if (req.method === "GET" && url.pathname === "/quote") {
      // report_data (64 bytes) = enclave X25519 pubkey (32) ‖ client nonce (32).
      const nonceHex = (url.searchParams.get("nonce") || "").replace(/^0x/, "");
      const nonce = Buffer.from(nonceHex, "hex");
      if (nonce.length !== 32) return send(res, 400, { error: "nonce must be 32 bytes hex" });
      const reportData = Buffer.concat([ENC.rawPub, nonce]); // exactly 64 bytes
      const q = await getDstack().getQuote(reportData);
      return send(res, 200, {
        quote: q.quote,
        event_log: q.event_log,
        encPub: ENC.rawPub.toString("hex"),
      });
    }

    if (req.method === "POST" && url.pathname === "/prove") {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const circuit = body.circuit;
      if (!CIRCUITS.includes(circuit)) {
        return send(res, 400, { error: `unknown circuit '${circuit}'` });
      }
      // Witness arrives either sealed (enc) or in clear (input).
      const input = body.enc ? decryptWitness(ENC.privateKey, body.enc).input : body.input;
      if (!input || typeof input !== "object") return send(res, 400, { error: "missing witness input" });
      const t0 = Date.now();
      const { proof, publicSignals } = await proveCircuit(circuit, input);
      console.log(`[prover] proved ${circuit} in ${Date.now() - t0}ms (sealed=${!!body.enc})`);
      return send(res, 200, { proof, publicSignals });
    }

    // ---- TEE-attested phase-2 ceremony contribution -------------------------
    // POST /contribute { circuit } → contribute to <circuit>.zkey with entropy
    // generated INSIDE this enclave (never returned), and return a TDX quote
    // binding (inputZkeyHash ‖ outputZkeyHash). The new (PUBLIC) zkey is then
    // fetched via GET /artifact. Makes a SOLO contribution credibly 1-of-N honest.
    if (req.method === "POST" && url.pathname === "/contribute") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const circuit = body.circuit;
      const t0 = Date.now();
      const r = await contributeCircuit(circuit, body.name || "benzo-tee-contributor");
      let quote = null, event_log = null;
      try {
        const q = await getDstack().getQuote(ceremonyReportData(r.inputZkeyHash, r.outputZkeyHash));
        quote = q.quote; event_log = q.event_log;
      } catch (e) { console.warn("[ceremony] no quote (not in a CVM?):", e?.message); }
      console.log(`[ceremony] contributed ${circuit} in ${Date.now() - t0}ms`);
      return send(res, 200, { ...r, outPath: undefined, artifact: `${circuit}.contrib.zkey`, quote, event_log });
    }

    // GET /artifact?name=<circuit>.contrib.zkey → stream a PUBLIC ceremony output.
    if (req.method === "GET" && url.pathname === "/artifact") {
      const name = (url.searchParams.get("name") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      const circuit = name.split(".")[0];
      const path = join(ARTIFACT_ROOT, circuit, name);
      if (!name.endsWith(".contrib.zkey") || !existsSync(path)) return send(res, 404, { error: "no such artifact" });
      res.writeHead(200, { "content-type": "application/octet-stream", ...CORS });
      return createReadStream(path).pipe(res);
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[prover] error:", e?.message || e);
    return send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => console.log(`[prover] listening on :${PORT}`));
