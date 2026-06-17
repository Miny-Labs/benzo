#!/usr/bin/env node
/**
 * Generate a real funds_attestation proof and print its Soroban proof + public
 * inputs, so we can verify it on-chain (proves the new proof-of-funds circuit
 * verifies on the deployed Stellar BN254 verifier).
 */
import { fileURLToPath } from "node:url";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { prove, toWitnessInput } from "../dist/index.js";

const root = fileURLToPath(new URL("../../../circuits/build", import.meta.url));
const art = {
  wasmPath: `${root}/funds_attestation/funds_attestation_js/funds_attestation.wasm`,
  zkeyPath: `${root}/funds_attestation/funds_attestation.zkey`,
};

const eddsa = await buildEddsa();
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (xs) => F.toObject(poseidon(xs));

const THRESHOLD = 500_000n, ASSET_ID = 7n, TIMESTAMP = 1_700_000_000n;
const CURRENT_TIME = 1_700_000_500n, MAX_AGE = 3_600n, BALANCE = 1_000_000n, HOLDER_SK = 12345n;

const oraclePrv = Buffer.alloc(32, 5);
const oraclePub = eddsa.prv2pub(oraclePrv);
const oracleAx = F.toObject(oraclePub[0]), oracleAy = F.toObject(oraclePub[1]);
const oracleKeyId = H([oracleAx, oracleAy]);
const hp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, HOLDER_SK);
const holderBinding = H([F.toObject(hp[0]), F.toObject(hp[1])]);
const msgEl = poseidon([holderBinding, BALANCE, ASSET_ID, TIMESTAMP]);
const sig = eddsa.signPoseidon(oraclePrv, msgEl);

const w = {
  oracleKeyId, threshold: THRESHOLD, assetId: ASSET_ID, currentTime: CURRENT_TIME,
  maxAgeSeconds: MAX_AGE, holderBinding, oracleAx, oracleAy,
  sigS: sig.S, sigR8x: F.toObject(sig.R8[0]), sigR8y: F.toObject(sig.R8[1]),
  balance: BALANCE, timestamp: TIMESTAMP, holderSk: HOLDER_SK,
};

const res = await prove(art, toWitnessInput(w));
console.log(JSON.stringify({ proof: res.sorobanProof, publics: res.sorobanPublics }));
