/**
 * Org (M-of-N) identity + member signing for in-circuit dual-control spends.
 *
 * An org treasury note is owned by an M-of-N *member set*, not a single key
 * (see notes.ts `orgRecipientPk`). To move it, `pool.transfer_org` requires a
 * `joinsplit_org` proof carrying ≥ threshold distinct member EdDSA signatures
 * over the spend message. This module builds that member set (a Baby-Jubjub
 * EdDSA keypair per member + a Merkle tree of member key-ids) and signs the
 * spend message — the cryptographic embodiment of a maker-checker approval.
 *
 * Browser-safe: circomlibjs (eddsa + poseidon) is already a dependency. The
 * heavy WASM builders are lazily constructed once and reused.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { MerkleTreeMirror } from "./merkle.js";
import { orgRecipientPk } from "./notes.js";
import { FIELD_MODULUS } from "./crypto/poseidon2.js";
import { toHex } from "./crypto/bytes.js";
import { randomBytes } from "./crypto/random.js";

/** Depth of the in-circuit member tree — must match JoinSplitOrg(_, ML=16). */
export const ORG_MEMBER_DEPTH = 16;

// Lazy circomlibjs singletons (WASM init is ~50ms; do it once).
let _eddsa: Awaited<ReturnType<typeof buildEddsa>> | null = null;
let _poseidon: Awaited<ReturnType<typeof buildPoseidon>> | null = null;
async function prims() {
  if (!_eddsa) _eddsa = await buildEddsa();
  if (!_poseidon) _poseidon = await buildPoseidon();
  return { eddsa: _eddsa, poseidon: _poseidon, F: _poseidon.F };
}

/** One org member: a Baby-Jubjub EdDSA keypair + its in-circuit key-id leaf. */
export interface OrgMember {
  /** 32-byte EdDSA private key (the member's downloadable signing key). */
  prv: Uint8Array;
  /** Public key coordinates (decimal field elements). */
  Ax: bigint;
  Ay: bigint;
  /** Member-tree leaf = Poseidon(Ax, Ay) — the identity committed on-chain. */
  keyId: bigint;
}

/** Derive a member from a 32-byte secret (download/self-sign material). */
export async function memberFromSecret(prv32: Uint8Array): Promise<OrgMember> {
  if (prv32.length !== 32) throw new Error("member secret must be 32 bytes");
  const { eddsa, poseidon, F } = await prims();
  const pub = eddsa.prv2pub(Buffer.from(prv32));
  const Ax = F.toObject(pub[0]) as bigint;
  const Ay = F.toObject(pub[1]) as bigint;
  const keyId = F.toObject(poseidon([Ax, Ay])) as bigint;
  return { prv: prv32, Ax, Ay, keyId };
}

/** Fresh random member (its `prv` is the key the member downloads + holds). */
export async function generateOrgMember(): Promise<OrgMember> {
  return memberFromSecret(randomBytes(32));
}

/** A signature share over a spend message (the in-circuit EdDSA sig). */
export interface OrgSignature {
  S: bigint;
  R8x: bigint;
  R8y: bigint;
}

/** The resolved org identity: member set + tree + the note owner key. */
export interface OrgIdentity {
  members: OrgMember[];
  threshold: bigint;
  /** Group spend-auth secret (FROST-style ak; held by the org). */
  akGroup: bigint;
  memberTree: MerkleTreeMirror;
  memberRoot: bigint;
  /** Per-member Merkle path proving membership in `memberRoot`. */
  memberPaths: { pathElements: bigint[]; pathIndices: number }[];
  /** The org notes' owner: recipientPk = orgRecipientPk(memberRoot, threshold, akGroup). */
  recipientPk: bigint;
}

/**
 * Assemble an org identity from its members. The member key-ids are inserted
 * into a depth-`ORG_MEMBER_DEPTH` tree (Poseidon2) whose root is bound into the
 * org note's recipientPk; `akGroup` is the group spend-auth secret.
 */
export async function buildOrgIdentity(
  members: OrgMember[],
  threshold: bigint,
  akGroup: bigint,
): Promise<OrgIdentity> {
  if (members.length === 0) throw new Error("org needs ≥1 member");
  if (threshold <= 0n || threshold > BigInt(members.length)) {
    throw new Error(`threshold ${threshold} out of range for ${members.length} members`);
  }
  const memberTree = new MerkleTreeMirror(ORG_MEMBER_DEPTH);
  const idx = members.map((m) => memberTree.insert(m.keyId));
  const memberRoot = memberTree.root();
  const memberPaths = idx.map((i) => {
    const p = memberTree.path(i);
    return { pathElements: p.pathElements, pathIndices: Number(p.pathIndices) };
  });
  const recipientPk = orgRecipientPk(memberRoot, threshold, akGroup);
  return { members, threshold, akGroup, memberTree, memberRoot, memberPaths, recipientPk };
}

/**
 * The message ≥threshold members must sign for a 2-in/2-out org spend:
 *   spendMessage = Poseidon(nullifier0, nullifier1, outCommitment0, outCommitment1).
 * Derived from the (public) nullifiers + output commitments, so any change to
 * the spend invalidates the signatures — they must be collected LAST.
 */
export async function orgSpendMessage(
  n0: bigint,
  n1: bigint,
  c0: bigint,
  c1: bigint,
): Promise<bigint> {
  const { poseidon, F } = await prims();
  return F.toObject(poseidon([n0, n1, c0, c1])) as bigint;
}

/** A member's EdDSA signature over a spend message (their approval). */
export async function signOrgSpend(
  member: OrgMember,
  message: bigint,
): Promise<OrgSignature> {
  const { eddsa, F } = await prims();
  const sig = eddsa.signPoseidon(Buffer.from(member.prv), F.e(message));
  return {
    S: sig.S as bigint,
    R8x: F.toObject(sig.R8[0]) as bigint,
    R8y: F.toObject(sig.R8[1]) as bigint,
  };
}

/**
 * Deterministically derive an org identity (member EdDSA keys + group spend-auth
 * secret) from a single root seed, domain-separated by orgId. HKDF is pure, so
 * the SAME (seed, orgId) yields the SAME identity in the browser, the CLI, and a
 * self-hosted BFF — the deployed and self-hosted apps interoperate, and a member
 * can re-derive their key by signing once (no second secret to store). Each
 * member's `prv` is the key that member downloads / holds for self-signing.
 *
 * The `memberRoot` this produces must be published on-chain (org_account
 * `set_member_root`) and matches the org notes' `recipientPk`.
 */
export async function deriveOrgIdentity(opts: {
  /** root IKM — the org owner's account seed or a dedicated org root secret. */
  seed: Uint8Array;
  /** namespace so one seed can host distinct orgs. */
  orgId: string | number;
  /** number of candidate members (≤ MAX_ORG_SIGNERS for a single spend). */
  memberCount: number;
  /** approvals required per spend. */
  threshold: bigint;
}): Promise<OrgIdentity> {
  const ns = `benzo/org/${opts.orgId}`;
  // group spend-auth secret: 64-byte OKM reduced mod p (negligible bias).
  const akOkm = hkdf(sha256, opts.seed, undefined, `${ns}/akgroup`, 64);
  const akGroup = BigInt("0x" + toHex(new Uint8Array(akOkm))) % FIELD_MODULUS;
  const members: OrgMember[] = [];
  for (let i = 0; i < opts.memberCount; i++) {
    const prv = new Uint8Array(hkdf(sha256, opts.seed, undefined, `${ns}/member/${i}/eddsa`, 32));
    members.push(await memberFromSecret(prv));
  }
  return buildOrgIdentity(members, opts.threshold, akGroup);
}
