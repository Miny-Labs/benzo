#!/usr/bin/env node
// Convert snarkjs Groth16 artifacts (verification_key.json / proof.json /
// public.json) into the byte encodings the Benzo Soroban verifier expects.
//
//   node groth16-to-soroban.mjs vk      <verification_key.json>
//   node groth16-to-soroban.mjs proof   <proof.json>
//   node groth16-to-soroban.mjs publics <public.json>
//
// Encodings (Soroban BN254 host-function conventions):
//   Fr / Fq  : 32-byte big-endian
//   G1       : x || y                                   (64 bytes)
//   G2       : x.c1 || x.c0 || y.c1 || y.c0             (128 bytes;
//              imaginary component first — Soroban's c1||c0 ordering,
//              while snarkjs JSON stores [c0, c1])

import { readFileSync } from "node:fs";

function feHex(dec) {
  const v = BigInt(dec);
  return v.toString(16).padStart(64, "0");
}

function g1Hex(pt) {
  // snarkjs G1: [x, y, "1"] (affine, z must be 1)
  if (BigInt(pt[2]) !== 1n) throw new Error("G1 point not affine (z != 1)");
  return feHex(pt[0]) + feHex(pt[1]);
}

function g2Hex(pt) {
  // snarkjs G2: [[x_c0, x_c1], [y_c0, y_c1], [z...]] -> c1 || c0 per coord
  if (BigInt(pt[2][0]) !== 1n || BigInt(pt[2][1]) !== 0n)
    throw new Error("G2 point not affine (z != [1,0])");
  return feHex(pt[0][1]) + feHex(pt[0][0]) + feHex(pt[1][1]) + feHex(pt[1][0]);
}

const [, , mode, file] = process.argv;
const data = JSON.parse(readFileSync(file, "utf8"));

if (mode === "vk") {
  const out = {
    alpha: g1Hex(data.vk_alpha_1),
    beta: g2Hex(data.vk_beta_2),
    gamma: g2Hex(data.vk_gamma_2),
    delta: g2Hex(data.vk_delta_2),
    ic: data.IC.map(g1Hex),
  };
  console.log(JSON.stringify(out));
} else if (mode === "proof") {
  const out = {
    a: g1Hex(data.pi_a),
    b: g2Hex(data.pi_b),
    c: g1Hex(data.pi_c),
  };
  console.log(JSON.stringify(out));
} else if (mode === "publics") {
  console.log(JSON.stringify(data.map(feHex)));
} else {
  console.error("usage: groth16-to-soroban.mjs vk|proof|publics <file>");
  process.exit(1);
}
