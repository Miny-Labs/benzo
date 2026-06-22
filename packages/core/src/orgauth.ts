/**
 * Anonymous approver / surveillance-free dual-control (Z5).
 *
 * Builds + proves the in-circuit M-of-N org spend-authorization (org_spend_auth,
 * vk_id ORGAUTH): at least `threshold` DISTINCT approvers each EdDSA-signed the
 * SAME run binding (`spendMessage`), WITHOUT revealing WHICH approvers signed.
 * The chain accepts the authorization only if a real threshold of member
 * signatures is present — dual-control becomes a property of the proof, and the
 * approver identities stay private (no surveillance trail of who signed what).
 *
 * The circuit enforces distinctness (no approver counts twice), and `authTag =
 * Poseidon(spendMessage, orgMemberRoot)` binds the authorization to this run +
 * this org (replay-resistant per run).
 *
 * Node-only (uses circomlibjs EdDSA/Poseidon); exported from index.ts, not the
 * browser entry. The managed service holds the approver seeds.
 *
 * Public inputs: [orgMemberRoot, threshold, spendMessage, authTag].
 */

import { buildEddsa, buildPoseidon } from "circomlibjs";
import { MerkleTreeMirror } from "./merkle.js";
import { toWitnessInput, type CircuitArtifacts, type ProveResult, type ProverPort } from "./prover.js";

// circuit fixed sizes: OrgSpendAuth(16, 3)
export const ORGAUTH_TREE_LEVELS = 16;
export const ORGAUTH_MAX_SIGNERS = 3;

/* eslint-disable @typescript-eslint/no-explicit-any */
let _eddsa: any;
let _poseidon: any;
async function tools(): Promise<{ eddsa: any; poseidon: any; F: any }> {
  if (!_eddsa) _eddsa = await buildEddsa();
  if (!_poseidon) _poseidon = await buildPoseidon();
  return { eddsa: _eddsa, poseidon: _poseidon, F: _poseidon.F };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface OrgAuthMember {
  Ax: bigint;
  Ay: bigint;
  keyId: bigint;
  prv: Uint8Array;
}

/** Deterministically derive an approver's EdDSA member from a seed byte. */
export async function deriveOrgAuthMember(seed: number): Promise<OrgAuthMember> {
  const { eddsa, poseidon, F } = await tools();
  const prv = new Uint8Array(32).fill(seed & 0xff);
  const pub = eddsa.prv2pub(prv);
  const Ax = F.toObject(pub[0]) as bigint;
  const Ay = F.toObject(pub[1]) as bigint;
  const keyId = F.toObject(poseidon([Ax, Ay])) as bigint;
  return { Ax, Ay, keyId, prv };
}

/** The org's approver member root (Poseidon-Merkle over keyIds) for a seed set. */
export async function orgAuthMemberRoot(memberSeeds: number[]): Promise<bigint> {
  const members = await Promise.all(memberSeeds.map((s) => deriveOrgAuthMember(s)));
  const tree = new MerkleTreeMirror(ORGAUTH_TREE_LEVELS);
  for (const m of members) tree.insert(m.keyId);
  return tree.root();
}

export interface ProveOrgApprovalParams {
  prover: ProverPort; // proving backend
  artifacts: CircuitArtifacts; // org_spend_auth wasm + zkey
  memberSeeds: number[]; // the N approver seeds (managed service holds these)
  signerIndices: number[]; // which members actually approved (length ≥ threshold)
  threshold: bigint; // M
  spendMessage: bigint; // the run binding every approver signs
}

/**
 * Build the witness and generate an anonymous M-of-N approval proof. The proof
 * attests `signerIndices.length` distinct members signed `spendMessage`, but the
 * public inputs reveal only the count threshold — never which members.
 */
export async function proveOrgApproval(
  params: ProveOrgApprovalParams,
): Promise<ProveResult & { root: bigint; authTag: bigint; approvers: number }> {
  const { eddsa, poseidon, F } = await tools();
  const members = await Promise.all(params.memberSeeds.map((s) => deriveOrgAuthMember(s)));
  const tree = new MerkleTreeMirror(ORGAUTH_TREE_LEVELS);
  const idx = members.map((m) => tree.insert(m.keyId));
  const root = tree.root();
  const authTag = F.toObject(poseidon([params.spendMessage, root])) as bigint;
  const msgEl = F.e(params.spendMessage);

  const enabled: bigint[] = [];
  const Ax: bigint[] = [];
  const Ay: bigint[] = [];
  const S: bigint[] = [];
  const R8x: bigint[] = [];
  const R8y: bigint[] = [];
  const pathElements: bigint[][] = [];
  const pathIndices: bigint[] = [];
  for (let i = 0; i < members.length; i++) {
    const on = params.signerIndices.includes(i);
    const sig = eddsa.signPoseidon(members[i].prv, msgEl);
    const p = tree.path(idx[i]);
    enabled.push(on ? 1n : 0n);
    Ax.push(members[i].Ax);
    Ay.push(members[i].Ay);
    S.push(sig.S as bigint);
    R8x.push(F.toObject(sig.R8[0]) as bigint);
    R8y.push(F.toObject(sig.R8[1]) as bigint);
    pathElements.push(p.pathElements);
    pathIndices.push(BigInt(p.pathIndices));
  }

  const witness = toWitnessInput({
    orgMemberRoot: root,
    threshold: params.threshold,
    spendMessage: params.spendMessage,
    authTag,
    enabled,
    Ax,
    Ay,
    S,
    R8x,
    R8y,
    pathElements,
    pathIndices,
  });
  const res = await params.prover.prove(params.artifacts, witness);
  return { ...res, root, authTag, approvers: params.signerIndices.length };
}
