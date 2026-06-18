/**
 * Witness confidentiality for the enclave (decrypt side).
 *
 * The dstack gateway TERMINATES TLS at the edge, so HTTPS alone would expose the
 * witness to the gateway. Instead the enclave holds an ephemeral X25519 keypair
 * and publishes its public key INSIDE the attestation quote's report_data
 * (pubkey ‖ client-nonce). The client verifies the quote, extracts the *attested*
 * pubkey, and ECIES-encrypts the witness to it — so only code running in this
 * attested enclave can decrypt it. Standard Node crypto only (X25519 + HKDF-SHA256
 * + AES-256-GCM); no extra deps. Wire framing is hex (matches the @noble client).
 */
import {
  generateKeyPairSync,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
} from "node:crypto";

const SALT = Buffer.from("benzo-tee-witness-v1");
const INFO = Buffer.from("x25519-hkdf-aesgcm");

const hex = (buf) => Buffer.from(buf).toString("hex");
const unhex = (s) => Buffer.from(s, "hex");

/** Generate the enclave's ephemeral X25519 keypair (per boot). */
export function genEnclaveKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"); // 32 bytes
  return { publicKey, privateKey, rawPub };
}

/** Import a raw 32-byte X25519 public key (the client's ephemeral key). */
function importRawX25519Pub(raw) {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") },
    format: "jwk",
  });
}

/**
 * Decrypt a witness payload {epk, iv, ct, tag} (all hex) that was sealed to this
 * enclave's public key. `priv` is the enclave private KeyObject.
 */
export function decryptWitness(priv, payload) {
  const epk = importRawX25519Pub(unhex(payload.epk));
  const shared = diffieHellman({ privateKey: priv, publicKey: epk });
  const key = Buffer.from(hkdfSync("sha256", shared, SALT, INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, unhex(payload.iv));
  decipher.setAuthTag(unhex(payload.tag));
  const pt = Buffer.concat([decipher.update(unhex(payload.ct)), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}
