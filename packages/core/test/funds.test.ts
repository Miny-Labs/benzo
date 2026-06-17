/**
 * Proof-of-funds (funds_attestation) circuit test. Builds a real oracle
 * EdDSA-over-BabyJubJub signature over Poseidon(holderBinding, balance, assetId,
 * timestamp) with circomlibjs, proves through the compiled circuit, and asserts:
 * a valid attestation proves; balance<threshold / stale / future-dated / tampered
 * signature / wrong-holder all FAIL to prove. The balance + timestamp stay
 * private. Self-skips when the gitignored proving artifacts are absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { prove, toWitnessInput, verifyLocal } from "../src/prover.js";

const root = fileURLToPath(new URL("../../../circuits/build", import.meta.url));
const art = {
  wasmPath: `${root}/funds_attestation/funds_attestation_js/funds_attestation.wasm`,
  zkeyPath: `${root}/funds_attestation/funds_attestation.zkey`,
};
const vk = () => JSON.parse(readFileSync(`${root}/funds_attestation/funds_attestation_vk.json`, "utf8"));
const HAVE = existsSync(art.zkeyPath);

// biome-ignore lint: test-local mutable singletons
let eddsa: any, poseidon: any, F: any;
beforeAll(async () => {
  eddsa = await buildEddsa();
  poseidon = await buildPoseidon();
  F = poseidon.F;
});
const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));

function buildWitness() {
  const THRESHOLD = 500_000n;
  const ASSET_ID = 7n;
  const TIMESTAMP = 1_700_000_000n; // when the oracle observed the balance
  const CURRENT_TIME = 1_700_000_500n; // 500s later
  const MAX_AGE = 3_600n; // 1h freshness window
  const BALANCE = 1_000_000n; // hidden; >= threshold
  const HOLDER_SK = 12345n;

  // Oracle EdDSA keypair (Plaid-backed enclave signer).
  const oraclePrv = Buffer.alloc(32, 5);
  const oraclePub = eddsa.prv2pub(oraclePrv);
  const oracleAx = F.toObject(oraclePub[0]);
  const oracleAy = F.toObject(oraclePub[1]);
  const oracleKeyId = H([oracleAx, oracleAy]);

  // Holder binding = Poseidon(holderSk * Base8).
  const hp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, HOLDER_SK);
  const holderBinding = H([F.toObject(hp[0]), F.toObject(hp[1])]);

  // Oracle signs Poseidon(holderBinding, balance, assetId, timestamp).
  const msgEl = poseidon([holderBinding, BALANCE, ASSET_ID, TIMESTAMP]);
  const sig = eddsa.signPoseidon(oraclePrv, msgEl);

  return {
    oracleKeyId,
    threshold: THRESHOLD,
    assetId: ASSET_ID,
    currentTime: CURRENT_TIME,
    maxAgeSeconds: MAX_AGE,
    holderBinding,
    oracleAx,
    oracleAy,
    sigS: sig.S,
    sigR8x: F.toObject(sig.R8[0]),
    sigR8y: F.toObject(sig.R8[1]),
    balance: BALANCE,
    timestamp: TIMESTAMP,
    holderSk: HOLDER_SK,
  };
}

describe.skipIf(!HAVE)("funds_attestation circuit (proof-of-funds)", () => {
  it("proves balance >= threshold without revealing the balance", async () => {
    const w = buildWitness();
    const res = await prove(art, toWitnessInput(w));
    // public order: [oracleKeyId, threshold, assetId, currentTime, maxAgeSeconds, holderBinding]
    expect(res.sorobanPublics.length).toBe(6);
    expect(BigInt(res.publicSignals[0])).toBe(w.oracleKeyId);
    expect(BigInt(res.publicSignals[1])).toBe(w.threshold);
    expect(BigInt(res.publicSignals[5])).toBe(w.holderBinding);
    expect(await verifyLocal(vk(), res.publicSignals, res.proof)).toBe(true);
  }, 120_000);

  it("rejects when balance < threshold", async () => {
    const w = buildWitness();
    await expect(
      prove(art, toWitnessInput({ ...w, threshold: w.balance + 1n })),
    ).rejects.toThrow();
  }, 120_000);

  it("rejects a stale attestation (older than the freshness window)", async () => {
    const w = buildWitness();
    await expect(
      prove(art, toWitnessInput({ ...w, currentTime: w.timestamp + w.maxAgeSeconds + 1n })),
    ).rejects.toThrow();
  }, 120_000);

  it("rejects a future-dated attestation", async () => {
    const w = buildWitness();
    await expect(
      prove(art, toWitnessInput({ ...w, timestamp: w.currentTime + 1n })),
    ).rejects.toThrow();
  }, 120_000);

  it("rejects a tampered oracle signature", async () => {
    const w = buildWitness();
    await expect(prove(art, toWitnessInput({ ...w, sigS: w.sigS + 1n }))).rejects.toThrow();
  }, 120_000);

  it("rejects a wrong-holder binding", async () => {
    const w = buildWitness();
    await expect(
      prove(art, toWitnessInput({ ...w, holderBinding: w.holderBinding + 1n })),
    ).rejects.toThrow();
  }, 120_000);
});
