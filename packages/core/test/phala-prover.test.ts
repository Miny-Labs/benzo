/**
 * PhalaProver — the attested TEE proving path. The key security property: the
 * witness is NEVER transmitted unless the enclave attestation verifies and the
 * measurement matches the pinned value. A fake attestation verifier + a
 * call-counting fetch prove the gate. The success path also exercises the sealed
 * (ECIES-to-attested-key) transport and the client-side Soroban re-encoding.
 */
import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { PhalaProver, type AttestationVerifier } from "../src/prover.js";

const MEASUREMENT = "mrenclave_abc123";
const ENCLAVE_PUB = Array.from(x25519.getPublicKey(x25519.utils.randomPrivateKey()), (b) =>
  b.toString(16).padStart(2, "0"),
).join("");

// A minimally-valid snarkjs proof shape so client-side proofToSoroban succeeds.
const proof = {
  pi_a: ["1", "2", "1"],
  pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
  pi_c: ["5", "6", "1"],
} as never;

function countingFetch(counter: { sent: number; sealed: boolean }) {
  return (async (_url: string, init: { body: string }) => {
    counter.sent++;
    const body = JSON.parse(init.body);
    counter.sealed = !!body.enc && !body.input; // witness is sealed, not plaintext
    return { ok: true, json: async () => ({ proof, publicSignals: ["1"] }) };
  }) as unknown as typeof fetch;
}

const okAttestor: AttestationVerifier = {
  async verify() { return { ok: true, measurement: MEASUREMENT, enclavePublicKey: ENCLAVE_PUB }; },
};
const failAttestor: AttestationVerifier = { async verify() { return { ok: false }; } };
const wrongMeasure: AttestationVerifier = {
  async verify() { return { ok: true, measurement: "evil_enclave", enclavePublicKey: ENCLAVE_PUB }; },
};
const noKeyAttestor: AttestationVerifier = {
  async verify() { return { ok: true, measurement: MEASUREMENT }; }, // attested but no key
};

describe("PhalaProver", () => {
  it("seals + sends the witness and returns the proof only after attestation + measurement check", async () => {
    const counter = { sent: 0, sealed: false };
    const prover = new PhalaProver("https://enclave", okAttestor, MEASUREMENT, countingFetch(counter));
    const res = await prover.prove({ wasmPath: "", zkeyPath: "", circuit: "joinsplit" }, { x: "1" });
    expect(res.publicSignals).toEqual(["1"]);
    expect(res.sorobanProof).toBeTruthy(); // re-encoded client-side
    expect(counter.sent).toBe(1);
    expect(counter.sealed).toBe(true); // witness was encrypted, never plaintext
  });

  it("does NOT send the witness if attestation fails", async () => {
    const counter = { sent: 0, sealed: false };
    const prover = new PhalaProver("https://enclave", failAttestor, MEASUREMENT, countingFetch(counter));
    await expect(prover.prove({ wasmPath: "", zkeyPath: "" }, {})).rejects.toThrow(/attestation failed/);
    expect(counter.sent).toBe(0); // witness never transmitted
  });

  it("does NOT send the witness if the measurement doesn't match the pin", async () => {
    const counter = { sent: 0, sealed: false };
    const prover = new PhalaProver("https://enclave", wrongMeasure, MEASUREMENT, countingFetch(counter));
    await expect(prover.prove({ wasmPath: "", zkeyPath: "" }, {})).rejects.toThrow(/measurement mismatch/);
    expect(counter.sent).toBe(0);
  });

  it("REFUSES to send the witness in clear if no enclave key was attested", async () => {
    const counter = { sent: 0, sealed: false };
    const prover = new PhalaProver("https://enclave", noKeyAttestor, MEASUREMENT, countingFetch(counter));
    await expect(prover.prove({ wasmPath: "", zkeyPath: "" }, {})).rejects.toThrow(/no attested enclave key/);
    expect(counter.sent).toBe(0);
  });
});
