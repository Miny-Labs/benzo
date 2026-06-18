/**
 * End-to-end KYC pipeline: CredentialIssuer (the re-issuer that turns a verified
 * identity tier into a signed credential) → the real kyc_credential circuit.
 * Proves that a credential minted by @benzo/kyc's CredentialIssuer verifies in
 * ZK and surfaces the assurance tier as credType (public input #1) — the value
 * the on-chain admit_by_proof tier gate binds. Self-skips without artifacts.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { CredentialIssuer, AssuranceTier } from "@benzo/kyc";
import { MerkleTreeMirror } from "../src/merkle.js";
import { prove, toWitnessInput, verifyLocal } from "../src/prover.js";

const root = fileURLToPath(new URL("../../../circuits/build", import.meta.url));
const art = { wasmPath: `${root}/kyc_credential/kyc_credential_js/kyc_credential.wasm`, zkeyPath: `${root}/kyc_credential/kyc_credential.zkey` };
const vk = () => JSON.parse(readFileSync(`${root}/kyc_credential/kyc_credential_vk.json`, "utf8"));
const HAVE = existsSync(art.zkeyPath);

// biome-ignore lint: shared singletons
let eddsa: any, poseidon: any, F: any, issuer: CredentialIssuer;
beforeAll(async () => {
  eddsa = await buildEddsa();
  poseidon = await buildPoseidon();
  F = poseidon.F;
  issuer = await CredentialIssuer.create("03".repeat(32));
});
const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));

describe.skipIf(!HAVE)("CredentialIssuer → kyc_credential circuit", () => {
  it("an issuer-signed tier-2 credential proves in ZK and surfaces credType=2", async () => {
    const HOLDER_SK = 12345n;
    const SCOPE = 4242n;
    const ADMIT_BLINDING = 555n;

    // Holder key → addressBinding the circuit recomputes from holderSk.
    const hp = eddsa.babyJub.mulPointEscalar(eddsa.babyJub.Base8, HOLDER_SK);
    const addressBinding = H([F.toObject(hp[0]), F.toObject(hp[1])]);

    // Re-issuer signs a tier-2 (VERIFIED_ID) credential bound to the holder.
    const cred = issuer.issue({
      holderBinding: addressBinding,
      tier: AssuranceTier.VERIFIED_ID,
      expiry: 1_900_000_000n,
      serial: 7n,
    });

    // Authorized-issuer registry: the issuer's key id is a member.
    const tree = new MerkleTreeMirror(16);
    const path = tree.path(tree.insert(cred.issuerKeyId));

    const witness = {
      issuerRegistryRoot: tree.root(),
      credType: cred.credType,
      currentTime: 1_700_000_000n,
      scope: SCOPE,
      identityNullifier: H([SCOPE, HOLDER_SK]),
      addressBinding,
      admitLeaf: H([addressBinding, ADMIT_BLINDING]),
      issuerAx: cred.issuerAx,
      issuerAy: cred.issuerAy,
      sigS: cred.sigS,
      sigR8x: cred.sigR8x,
      sigR8y: cred.sigR8y,
      holderSk: HOLDER_SK,
      attrHash: cred.attrHash,
      expiry: cred.expiry,
      serial: cred.serial,
      issuerPathElements: path.pathElements,
      issuerPathIndices: path.pathIndices,
      admitBlinding: ADMIT_BLINDING,
    };

    const res = await prove(art, toWitnessInput(witness));
    expect(await verifyLocal(vk(), res.publicSignals, res.proof)).toBe(true);
    // public order: [issuerRegistryRoot, credType, currentTime, scope, ...]
    expect(BigInt(res.publicSignals[1])).toBe(2n); // tier surfaced as credType
  }, 120_000);
});
