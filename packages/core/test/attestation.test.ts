/**
 * DstackAttestationVerifier — verifies the off-enclave attestation logic with an
 * injected (deterministic) quote verifier + fetch, so we exercise: TCB status
 * gating, report_data nonce freshness, compose-hash binding (quote MRCONFIGID vs
 * event log), and the attested-key extraction — without real TDX hardware.
 */
import { describe, it, expect } from "vitest";
import { DstackAttestationVerifier, replayRtmr } from "../src/attestation.js";

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

const NONCE = new Uint8Array(32).fill(0x11);
const ENCLAVE_PUB = new Uint8Array(32).fill(0x22);
const COMPOSE = "ab".repeat(32); // 32-byte compose-hash (64 hex)
// dstack binds the compose-hash in MRCONFIGID as 0x01 ‖ compose ‖ padding (48 bytes).
const MRCONFIGID = ("01" + COMPOSE + "00".repeat(48)).slice(0, 96);

const events = [
  { imr: 3, event_type: 1, digest: "aa".repeat(48), event: "compose-hash", event_payload: COMPOSE },
  { imr: 3, event_type: 1, digest: "bb".repeat(48), event: "instance-id", event_payload: "ff00" },
];
const reportData = new Uint8Array([...ENCLAVE_PUB, ...NONCE]); // 64 bytes

function makeVerifier(over: Record<string, unknown> = {}, evts = events) {
  const verifyQuote = async () => ({
    status: "UpToDate",
    rtmr3: "dd".repeat(48),
    mrtd: "cc".repeat(48),
    mrConfigId: MRCONFIGID,
    reportData,
    ...over,
  });
  const fetchImpl = (async () => ({
    ok: true,
    json: async () => ({ quote: "00", event_log: JSON.stringify(evts) }),
  })) as unknown as typeof fetch;
  return new DstackAttestationVerifier({ fetchImpl, verifyQuote, randomNonce: () => NONCE });
}

describe("DstackAttestationVerifier", () => {
  it("accepts a genuine quote: returns compose-hash (from MRCONFIGID) + attested key", async () => {
    const r = await makeVerifier().verify("https://enclave");
    expect(r.ok).toBe(true);
    expect(r.measurement).toBe(COMPOSE);
    expect(r.composeHash).toBe(COMPOSE);
    expect(r.enclavePublicKey).toBe(toHex(ENCLAVE_PUB));
  });

  it("rejects an unacceptable TCB status (witness gate fails)", async () => {
    const r = await makeVerifier({ status: "OutOfDate" }).verify("https://enclave");
    expect(r.ok).toBe(false);
  });

  it("rejects a stale/replayed quote whose report_data nonce doesn't echo ours", async () => {
    const wrongNonce = new Uint8Array([...ENCLAVE_PUB, ...new Uint8Array(32).fill(0x99)]);
    const r = await makeVerifier({ reportData: wrongNonce }).verify("https://enclave");
    expect(r.ok).toBe(false);
  });

  it("rejects an event log whose compose-hash isn't bound to the quote's MRCONFIGID", async () => {
    const forged = [{ imr: 3, event_type: 1, digest: "aa".repeat(48), event: "compose-hash", event_payload: "ee".repeat(32) }];
    const r = await makeVerifier({}, forged).verify("https://enclave");
    expect(r.ok).toBe(false);
  });

  it("replayRtmr starts from the 48-byte zero seed and folds SHA-384", () => {
    expect(replayRtmr([], 3)).toBe("00".repeat(48));
    expect(replayRtmr(events, 3).length).toBe(96);
  });
});
