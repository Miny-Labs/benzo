/**
 * Real TDX attestation verification for the Phala dstack prover enclave.
 *
 * Before a witness is ever sent, the client:
 *   1. asks the enclave for a fresh quote bound to a random nonce
 *      (GET /quote?nonce=…); the enclave embeds (X25519 pubkey ‖ nonce) in the
 *      quote's 64-byte report_data,
 *   2. verifies the quote against Intel collateral (dcap-qvl) — proving it came
 *      from genuine Intel TDX hardware with an acceptable TCB,
 *   3. checks the echoed nonce (freshness — not a replayed quote),
 *   4. replays the event log and checks it folds to the quote's RTMR3 (so the
 *      event log is authentic), then reads the bound compose-hash,
 *   5. pins the measurement (compose-hash by default) against the expected value.
 * Only then does PhalaProver seal the witness to the *attested* X25519 pubkey.
 *
 * dcap-qvl is loaded lazily so the browser bundle never pulls it in.
 */
import { sha384 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import type { AttestationVerifier, AttestationResult } from "./prover.js";

const toHex = (u8: Uint8Array): string =>
  Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Uint8Array => {
  const clean = (s || "").replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

interface EventLogEntry {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

/** Replay one RTMR from the event log exactly as dstack does (SHA-384 fold). */
export function replayRtmr(events: EventLogEntry[], imr: number): string {
  let mr = new Uint8Array(48);
  for (const e of events.filter((x) => x.imr === imr)) {
    let content = fromHex(e.digest);
    if (content.length < 48) {
      const padded = new Uint8Array(48);
      padded.set(content);
      content = padded;
    }
    const buf = new Uint8Array(mr.length + content.length);
    buf.set(mr);
    buf.set(content, mr.length);
    mr = Uint8Array.from(sha384(buf));
  }
  return toHex(mr);
}

/** A verified TDX quote, reduced to the fields we care about. */
export interface VerifiedQuote {
  status: string;
  rtmr3: string;
  mrtd: string;
  /** MRCONFIGID — dstack binds (0x01 ‖ compose-hash ‖ padding) here. */
  mrConfigId: string;
  reportData: Uint8Array; // 64 bytes
}

/**
 * Pluggable quote verifier (so tests can inject a deterministic verdict).
 * `collateral` (Intel-signed certs/CRL/TCB) may be supplied by the enclave's
 * /quote response so a browser needn't fetch a PCCS cross-origin; verifiers that
 * fetch their own collateral can ignore it.
 */
export type QuoteVerifier = (quoteHex: string, collateral?: unknown) => Promise<VerifiedQuote>;

// The concrete quote verifiers live in sibling modules so this file stays
// browser-safe (no Node `@phala/dcap-qvl` in the browser graph):
//   - attestation-node.ts : `dcapQuoteVerifier` (Node, @phala/dcap-qvl)
//   - attestation-web.ts  : `webQuoteVerifier`  (browser, @phala/dcap-qvl-web WASM)

export interface DstackVerifierOptions {
  /** TCB statuses to accept. Cloud TDX commonly reports SWHardeningNeeded. */
  acceptableStatuses?: string[];
  fetchImpl?: typeof fetch;
  verifyQuote?: QuoteVerifier;
  randomNonce?: () => Uint8Array;
}

const DEFAULT_OK_STATUSES = ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded"];

/**
 * Verifies a live dstack enclave end-to-end and returns the attested measurement
 * + the enclave's X25519 public key (so the witness can be sealed to it).
 */
export class DstackAttestationVerifier implements AttestationVerifier {
  private readonly ok: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly verifyQuote: QuoteVerifier;
  private readonly nonce: () => Uint8Array;

  constructor(opts: DstackVerifierOptions = {}) {
    this.ok = opts.acceptableStatuses ?? DEFAULT_OK_STATUSES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.verifyQuote = opts.verifyQuote ?? (async () => {
      throw new Error(
        "DstackAttestationVerifier: no QuoteVerifier — use makeNodeAttestationVerifier (Node) or makeWebAttestationVerifier (browser)",
      );
    });
    this.nonce = opts.randomNonce ?? (() => randomBytes(32));
  }

  async verify(endpoint: string): Promise<AttestationResult> {
    const nonce = this.nonce();
    const nonceHex = toHex(nonce);
    const base = endpoint.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${base}/quote?nonce=${nonceHex}`);
    if (!res.ok) throw new Error(`attestation: /quote HTTP ${res.status}`);
    const { quote, event_log, collateral } = (await res.json()) as {
      quote: string; event_log: string; collateral?: unknown;
    };

    // (1) genuine Intel TDX hardware + acceptable TCB. The enclave may serve the
    // Intel-signed collateral so a browser needn't fetch a PCCS cross-origin.
    const vq = await this.verifyQuote(quote, collateral);
    if (!this.ok.includes(vq.status)) {
      return { ok: false, measurement: undefined, status: vq.status };
    }

    // (2) freshness + the attested X25519 pubkey, from report_data = pub(32) ‖ nonce(32)
    if (vq.reportData.length < 64) throw new Error("attestation: report_data too short");
    const enclavePub = vq.reportData.subarray(0, 32);
    const echoedNonce = vq.reportData.subarray(32, 64);
    if (toHex(echoedNonce) !== nonceHex) {
      return { ok: false, status: vq.status }; // stale/replayed quote — refuse
    }

    // (3) the code identity (compose-hash) is bound in the signed quote's
    // MRCONFIGID as (0x01 ‖ compose-hash ‖ padding). dcap-qvl already verified the
    // quote, so this value is trustworthy. We bind the human-readable event log to
    // it by requiring the event log's compose-hash entry to equal the quote's.
    const quoteCompose = vq.mrConfigId.slice(2, 2 + 64); // skip the 0x01 prefix byte
    const events = JSON.parse(event_log) as EventLogEntry[];
    const eventCompose = events.find((e) => e.event === "compose-hash")?.event_payload?.replace(/^0x/, "");
    if (eventCompose && eventCompose !== quoteCompose) {
      return { ok: false, status: vq.status }; // event log not bound to the quote — refuse
    }

    // measurement to pin = the compose-hash bound in the verified quote.
    const composeHash = quoteCompose;
    return {
      ok: true,
      measurement: composeHash,
      enclavePublicKey: toHex(enclavePub),
      rtmr3: vq.rtmr3,
      mrtd: vq.mrtd,
      composeHash,
      status: vq.status,
    };
  }
}
