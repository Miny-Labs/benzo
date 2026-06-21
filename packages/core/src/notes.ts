/**
 * Benzo shielded notes — the canonical cryptographic invariants.
 *
 * Key hierarchy (mirrors circuits/groth16/note.circom BenzoSpendKeys):
 *   ak (spend-auth) = Poseidon2(orgSpendId, 0)  (domain 0x06)
 *   nk (nullifier)  = Poseidon2(orgSpendId, 1)  (domain 0x07)
 *   commitment = Poseidon2(amount, recipient_pk, blinding, asset_id)
 *   nullifier  = Poseidon2(nk, leaf_index, NULLIFIER_DOMAIN)
 *   keypair    : recipient_pk = Poseidon2(ak, 0)  (domain 0x03)
 *   mvk tag    : tag = Poseidon2(mvk_pub, blinding) (domain 0x05)
 *
 * Splitting the spend-auth key `ak` from the nullifier key `nk` (Zcash Orchard /
 * Penumbra model) means a viewing/nullifier key never grants spend authority.
 */

import { toHex } from "./crypto/bytes.js";
import { randomBytes } from "./crypto/random.js";
import { FIELD_MODULUS, hash } from "./crypto/poseidon2.js";

export const NULLIFIER_DOMAIN = 0x02n;
export const KEYPAIR_DOMAIN = 0x03n;
export const MVK_TAG_DOMAIN = 0x05n;
export const ASP_LEAF_DOMAIN = 0x01n;
export const SPENDAUTH_DOMAIN = 0x06n;
export const NK_DOMAIN = 0x07n;
export const MVK_REGISTRY_LEAF_DOMAIN = 0x08n;
export const ORG_NOTE_DOMAIN = 0x09n;

// --------------------------------------------------------------- org notes ----
// An ORG note is a shielded note owned by an M-of-N member set, not a single key.
// Its recipient_pk is the PREIMAGE-BOUND hash of (memberRoot, threshold, the
// group spend-auth pub) under the ORG domain — so the only way to satisfy the
// commitment's owner branch is the in-circuit M-of-N path in `joinsplit_org`
// (`pool.transfer_org`). A single key can never move it: there is no `ak` whose
// keypair pub equals an org recipient_pk. Mirrors circuits/groth16/org_note_spend.

/** The org's GROUP spend-auth public — akGroup is the group key (FROST ak / dev). */
export function akGroupPub(akGroup: bigint): bigint {
  return hash([akGroup, 0n], KEYPAIR_DOMAIN);
}

/** Org note owner: recipient_pk = Poseidon2(memberRoot, threshold, akGroupPub; ORG). */
export function orgRecipientPk(memberRoot: bigint, threshold: bigint, akGroup: bigint): bigint {
  return hash([memberRoot, threshold, akGroupPub(akGroup)], ORG_NOTE_DOMAIN);
}

/**
 * Org-note nullifier — double-spend-safe AND unlinkable. Keyed by an org
 * nullifier secret nk_org = Poseidon2(akGroup, blinding; NK), so two org notes
 * of the same set produce unrelated nullifiers (no org spend-graph leak):
 *   nullifier = Poseidon2(nk_org, leaf_index; NULLIFIER).
 */
export function orgNullifier(akGroup: bigint, blinding: bigint, leafIndex: bigint): bigint {
  return hash([hash([akGroup, blinding], NK_DOMAIN), leafIndex], NULLIFIER_DOMAIN);
}

/**
 * Authorized-MVK registry leaf = Poseidon2(mvkPub, keyMeta) — mirrors
 * circuits/groth16/note.circom BenzoMvkRegistryLeaf. A note's MVK tag is only
 * valid when this leaf is a member of the registered-MVK root, so every note is
 * bound to a real registered viewing key. `keyMeta` packs org/scope/expiry/epoch.
 */
export function mvkRegistryLeaf(mvkPub: bigint, keyMeta: bigint): bigint {
  return hash([mvkPub, keyMeta], MVK_REGISTRY_LEAF_DOMAIN);
}

export interface SpendKeys {
  ak: bigint; // spend-auth pubkey (owner branch)
  nk: bigint; // nullifier key (separate branch)
}

/**
 * Derive the spend-auth key `ak` and the SEPARATE nullifier key `nk` from one
 * root `orgSpendId` — mirrors circuits/groth16/note.circom BenzoSpendKeys.
 * N=1 (consumer): orgSpendId is the account seed. M-of-N (org): orgSpendId is
 * split off-circuit via FROST with `ak` as the group key.
 */
export function deriveSpendKeys(orgSpendId: bigint): SpendKeys {
  return {
    ak: hash([orgSpendId, 0n], SPENDAUTH_DOMAIN),
    nk: hash([orgSpendId, 1n], NK_DOMAIN),
  };
}

/** Uniform-enough random field element (rejection-free; 2x reduction bias is negligible at 256->254 bits ~ 2^-2... use 512-bit reduction for true uniformity). */
export function randomFieldElement(): bigint {
  // 64 bytes reduced mod p: statistical distance < 2^-256.
  const wide = BigInt("0x" + toHex(randomBytes(64)));
  return wide % FIELD_MODULUS;
}

export interface Keypair {
  spendSk: bigint;
  publicKey: bigint;
}

export function deriveKeypair(spendSk: bigint): Keypair {
  // spendSk is the root orgSpendId; ownership binds to the spend-auth key ak.
  const { ak } = deriveSpendKeys(spendSk);
  return { spendSk, publicKey: hash([ak, 0n], KEYPAIR_DOMAIN) };
}

export function randomKeypair(): Keypair {
  return deriveKeypair(randomFieldElement());
}

export interface Note {
  amount: bigint;
  recipientPk: bigint;
  blinding: bigint;
  assetId: bigint;
}

export function noteCommitment(note: Note): bigint {
  // t=4 permutation over exactly [amount, recipient_pk, blinding, asset_id]
  // (asset_id in the capacity slot) — see circuits/groth16/note.circom.
  return hash([note.amount, note.recipientPk, note.blinding], note.assetId);
}

export function noteNullifier(spendSk: bigint, leafIndex: bigint): bigint {
  // Nullifier is keyed by the separate nullifier key nk, not the root.
  const { nk } = deriveSpendKeys(spendSk);
  return hash([nk, leafIndex], NULLIFIER_DOMAIN);
}

export function mvkTag(mvkPub: bigint, blinding: bigint): bigint {
  return hash([mvkPub, blinding], MVK_TAG_DOMAIN);
}

export function aspLeaf(depositorScalar: bigint, aspBlinding: bigint): bigint {
  return hash([depositorScalar, aspBlinding], ASP_LEAF_DOMAIN);
}

export function newNote(amount: bigint, recipientPk: bigint, assetId: bigint): Note {
  return { amount, recipientPk, blinding: randomFieldElement(), assetId };
}
