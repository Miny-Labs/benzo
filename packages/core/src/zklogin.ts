/**
 * zkLogin for Benzo — the Sui-zkLogin / Aptos-Keyless model, adapted to Stellar.
 *
 * HOW THE OTHER CHAINS DO IT (Sui zkLogin, Aptos Keyless):
 *   1. the wallet makes an ephemeral key pair and embeds nonce = H(eph_pk,
 *      max_epoch, randomness) into the OAuth request;
 *   2. the OIDC provider (Google) returns a JWT signed (RS256) over {iss, aud,
 *      sub, nonce, ...};
 *   3. a Groth16/BN254 proof proves, in zero knowledge: the JWT's RSA signature
 *      verifies against the provider's JWK, the nonce commits to eph_pk, and the
 *      account address = H(sub, aud, iss, salt) — without revealing the JWT/sub;
 *   4. the chain verifies that proof against the provider's published JWKs.
 *   The address is H(sub, aud, iss, salt) so it is STABLE per user yet UNLINKABLE
 *   to the Google identity (salt hides sub). Salt "option 4" = HKDF(seed, iss|aud, sub).
 *
 * BENZO MAPPING. Benzo's Soroban verifier already speaks the same proof system
 * (Groth16 over BN254 + Poseidon2), and `accountFromClaimSecret` is already the
 * HKDF salt-derivation. So:
 *   - Phase 1 (THIS FILE + the BFF Google verify): real Google OAuth → a real,
 *     signature-verified JWT → derive the Benzo account deterministically from
 *     the verified (iss, aud, sub) via HKDF. Same ephemeral-nonce binding + same
 *     unlinkable address model as Sui; the JWT's RSA signature is checked
 *     OFF-CHAIN (the BFF), so the chain trusts the BFF for the JWT step.
 *   - Phase 2 (docs/ZKLOGIN.md): move the JWT RSA verification IN-CIRCUIT
 *     (the heavy ~2^20 ptau circuit) so the chain verifies the proof against
 *     Google's JWKs directly — fully trustless, no BFF trust. The verifier needs
 *     no change (it already verifies Groth16/BN254).
 *
 * This module is the Phase-1 derivation: pure, browser-safe, deterministic.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { hash, FIELD_MODULUS } from "./crypto/poseidon2.js";
import { toHex } from "./crypto/bytes.js";
import { type BenzoAccount, createAccount } from "./account.js";

/** Domain tag for zkLogin nonce/address-seed hashes (distinct from note domains 0x01–0x09). */
export const ZKLOGIN_DOMAIN = 0x0an;

const enc = (s: string) => new TextEncoder().encode(s);
const feFromBytes = (b: Uint8Array): bigint => BigInt("0x" + toHex(b)) % FIELD_MODULUS;

/**
 * The OIDC nonce binding — commits the ephemeral pubkey + session expiry into the
 * OAuth request, exactly like Sui zkLogin (`nonce = H(eph_pk, max_epoch,
 * randomness)`). The app passes this as the `nonce` in the Google OAuth request;
 * a Phase-2 in-circuit proof checks the JWT's `nonce` equals this, binding the
 * Google login to the ephemeral key that signs the session.
 */
export function zkLoginNonce(ephemeralPubScalar: bigint, maxEpoch: bigint, randomness: bigint): string {
  return hash([ephemeralPubScalar, maxEpoch, randomness], ZKLOGIN_DOMAIN).toString();
}

export interface OidcIdentity {
  sub: string; // stable per-user subject id from the provider
  iss: string; // issuer, e.g. https://accounts.google.com
  aud: string; // audience = the OAuth client id
}

/**
 * The self-custodial salt-derived claim secret (zkLogin "salt option 4"):
 * HKDF(ikm = iss|aud|sub, salt). Same identity (+salt) → same secret → same Benzo
 * account; the on-chain identity is a hash of the DERIVED keys, so `sub` never
 * reaches the chain (unlinkability). The optional `salt` lets an org/app scope or
 * rotate the mapping.
 */
export function oidcClaimSecret(id: OidcIdentity, salt: Uint8Array | string = "benzo"): Uint8Array {
  const ikm = enc(`${id.iss}|${id.aud}|${id.sub}`);
  const saltBytes = typeof salt === "string" ? enc(salt) : salt;
  return new Uint8Array(hkdf(sha256, ikm, saltBytes, "benzo/zklogin/oidc", 32));
}

/**
 * Derive a full Benzo account (spend + viewing keys) from VERIFIED OIDC claims —
 * Phase-1 zkLogin. The caller MUST have verified the JWT signature first (the BFF
 * does this against Google's JWKs); this only does the deterministic key
 * derivation. Same model as `accountFromClaimSecret`, keyed by the OIDC identity.
 */
export function accountFromOidc(
  id: OidcIdentity,
  opts: { salt?: Uint8Array | string; app?: string } = {},
): BenzoAccount {
  const secret = oidcClaimSecret(id, opts.salt);
  const ns = opts.app ? `${opts.app}/` : "";
  const spendOkm = hkdf(sha256, secret, undefined, `benzo/zklogin/${ns}spend`, 32);
  const spendSk = feFromBytes(new Uint8Array(spendOkm));
  const mvkSecret = new Uint8Array(hkdf(sha256, secret, undefined, `benzo/zklogin/${ns}mvk`, 32));
  const viewSecret = new Uint8Array(hkdf(sha256, secret, undefined, `benzo/zklogin/${ns}view`, 32));
  return createAccount({ label: "zklogin", spendSk, mvkSecret, viewSecret });
}

/**
 * The unlinkable on-chain address seed for an OIDC identity (the zkLogin address
 * model): Poseidon2(H(sub), H(aud), salt). Stable per user, reveals nothing about
 * the Google account. This is the public identity a Phase-2 circuit would prove
 * the address is consistent with.
 */
export function oidcAddressSeed(id: OidcIdentity, salt: bigint): bigint {
  const subF = feFromBytes(sha256(enc(id.sub)));
  const audF = feFromBytes(sha256(enc(id.aud)));
  return hash([subF, audF, salt], ZKLOGIN_DOMAIN);
}
