/**
 * CLI-style arg → Soroban `ScVal` coercion, shared by the read path
 * (`StellarRpcClient.view`/simulate) and the client-side write path
 * (`buildInvokeTx`). The protocol uses a consistent arg-naming convention, so a
 * name → type table is enough; we never fetch the on-chain contract spec (the
 * SDK's spec parser chokes on our >10-fn specs).
 *
 * Two entry points share one table:
 *   - `scvalForArg`      — the read surface (no proof struct; reads never carry one).
 *   - `scvalForWriteArg` — the read surface PLUS the Groth16 `--proof` struct,
 *                          so a browser can build+sign a write client-side
 *                          instead of handing it to a custodial relayer.
 */

import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { fromHex } from "./crypto/bytes.js";

/** Coerce a single CLI read arg (`name`, `value`) to its ScVal by name. */
export function scvalForArg(name: string, value: string): xdr.ScVal {
  // VK identifier (e.g. "BALANCE"/"SHIELD") is an on-chain `Symbol`, NOT a
  // string — a String-for-Symbol arg traps the contract (UnreachableCodeReached).
  if (name === "vk_id") return nativeToScVal(value, { type: "symbol" });
  // Groth16 public inputs: a Vec<Bn254Fr> (encoded on-chain as Vec<U256>). Each
  // field element is a 254-bit scalar (decimal string) → U256, matching how the
  // verifier reads them. Lets a browser call verifier.verify_proof directly
  // (client-side ZK confirmation), not just simple reads.
  if (name === "public_inputs") {
    const arr = JSON.parse(value) as (string | number)[];
    return xdr.ScVal.scvVec(arr.map((x) => nativeToScVal(BigInt(x), { type: "u256" })));
  }
  // ciphertexts + public keys: Bytes (hex-encoded)
  if (/(^|_)ct\d?$/.test(name) || name === "spend_pub" || name === "view_pub") {
    return nativeToScVal(fromHex(value), { type: "bytes" });
  }
  // addresses (G…/C…)
  if (["address", "from", "to", "owner", "payee", "relayer", "submitter"].includes(name)) {
    return nativeToScVal(value, { type: "address" });
  }
  // signed token amounts: i128
  if (["amount", "fee", "min_amount", "paid_amount"].includes(name)) {
    return nativeToScVal(BigInt(value), { type: "i128" });
  }
  // unix timestamps: u64
  if (name === "expiry") return nativeToScVal(BigInt(value), { type: "u64" });
  // human strings
  if (["handle", "reference", "memo"].includes(name)) {
    return nativeToScVal(value, { type: "string" });
  }
  // default: field element (commitment / root / nullifier / tag / key / scalar) → U256
  if (/^\d+$/.test(value)) return nativeToScVal(BigInt(value), { type: "u256" });
  if (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)) {
    return nativeToScVal(value, { type: "address" });
  }
  return nativeToScVal(value, { type: "string" });
}

/**
 * The on-chain `Groth16Proof` is `{ a, b, c }` where `a`/`c` are 64-byte G1 and
 * `b` is a 128-byte G2 point — SDK-native `Bn254G1Affine`/`Bn254G2Affine`, each
 * wire-encoded as fixed-length `Bytes`. `proofToSoroban` already produced the
 * hex; here we lift `{a,b,c}` hex into the struct ScVal. (Field order a<b<c is
 * already the sorted ScMap order Soroban requires.)
 */
export function proofToScVal(json: string): xdr.ScVal {
  const p = JSON.parse(json) as { a: string; b: string; c: string };
  for (const f of ["a", "b", "c"] as const) {
    if (typeof p[f] !== "string") throw new Error(`proof missing "${f}"`);
  }
  // An `ScMap` with symbol keys is the contract-struct wire form. Keys must be
  // in sorted order (a < b < c, already satisfied); each point is fixed-length
  // `Bytes`.
  const field = (key: string, hex: string) =>
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(key),
      val: nativeToScVal(fromHex(hex), { type: "bytes" }),
    });
  return xdr.ScVal.scvMap([field("a", p.a), field("b", p.b), field("c", p.c)]);
}

/** Coerce a single CLI WRITE arg — the read table plus the `--proof` struct. */
export function scvalForWriteArg(name: string, value: string): xdr.ScVal {
  if (name === "proof") return proofToScVal(value);
  return scvalForArg(name, value);
}
