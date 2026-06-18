/**
 * Witness confidentiality for the client (encrypt side).
 *
 * Seals a payload to the enclave's *attested* X25519 public key (extracted from a
 * verified TDX quote's report_data — see attestation.ts). Only code running in
 * that attested enclave holds the matching private key, so the dstack gateway —
 * which terminates TLS — only ever sees ciphertext. Interops byte-for-byte with
 * the enclave's Node-crypto decrypt (X25519 + HKDF-SHA256 + AES-256-GCM, hex wire).
 */
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/hashes/utils";

const SALT = new TextEncoder().encode("benzo-tee-witness-v1");
const INFO = new TextEncoder().encode("x25519-hkdf-aesgcm");

const toHex = (u8: Uint8Array): string =>
  Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Uint8Array => {
  const clean = s.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export interface SealedPayload {
  /** client ephemeral X25519 public key (hex, 32 bytes) */
  epk: string;
  /** AES-GCM nonce (hex, 12 bytes) */
  iv: string;
  /** ciphertext (hex) */
  ct: string;
  /** AES-GCM auth tag (hex, 16 bytes) */
  tag: string;
}

/**
 * Seal `plaintextObj` (JSON-serializable) to the enclave's raw 32-byte X25519
 * public key. Returns the hex-framed payload the enclave's decryptWitness expects.
 */
export function sealToEnclave(enclavePubRawHex: string, plaintextObj: unknown): SealedPayload {
  const enclavePub = fromHex(enclavePubRawHex);
  if (enclavePub.length !== 32) throw new Error("enclave pubkey must be 32 bytes");
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, enclavePub);
  const key = hkdf(sha256, shared, SALT, INFO, 32);
  const iv = randomBytes(12);
  const pt = new TextEncoder().encode(JSON.stringify(plaintextObj));
  const sealed = gcm(key, iv).encrypt(pt); // ciphertext ‖ 16-byte tag
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return { epk: toHex(ephPub), iv: toHex(iv), ct: toHex(ct), tag: toHex(tag) };
}
