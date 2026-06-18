/**
 * CredentialIssuer — the re-issuer that turns a verified identity (any tier,
 * from Self / zkLogin / a document IDV) into a Benzo KYC credential the
 * `kyc_credential` circuit verifies in zero knowledge. It signs the exact
 * message the circuit checks — Poseidon(attrHash, addressBinding, issuerKeyId,
 * expiry, credType, serial) — with EdDSA-over-BabyJubJub (circomlibjs, the JS
 * twin of the vendored circomlib). `credType` carries the assurance TIER, so the
 * tier is authenticated and later bound on-chain by `admit_by_proof`.
 *
 * In production this runs inside the attested Phala enclave with the issuer key
 * sealed by dstack-kms — so the signing key never leaves the attested code.
 */
import { hexToBytes } from "@noble/hashes/utils";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — circomlibjs ships no types
import { buildEddsa, buildPoseidon } from "circomlibjs";
import type { AssuranceTier } from "./index.js";

/** The witness fields the `kyc_credential` circuit consumes (decimal bigints). */
export interface IssuedCredential {
  issuerAx: bigint;
  issuerAy: bigint;
  issuerKeyId: bigint;
  sigS: bigint;
  sigR8x: bigint;
  sigR8y: bigint;
  addressBinding: bigint;
  /** the assurance tier, signed in-circuit as credType */
  credType: bigint;
  expiry: bigint;
  serial: bigint;
  attrHash: bigint;
}

export class CredentialIssuer {
  private constructor(
    // biome-ignore lint: circomlibjs is untyped
    private readonly eddsa: any,
    private readonly poseidon: any,
    private readonly F: any,
    private readonly prv: Uint8Array,
  ) {}

  /** Build an issuer from a 32-byte BabyJubJub private key (bytes or hex). */
  static async create(issuerPrivateKey: Uint8Array | string): Promise<CredentialIssuer> {
    const eddsa = await buildEddsa();
    const poseidon = await buildPoseidon();
    const prv = typeof issuerPrivateKey === "string" ? hexToBytes(issuerPrivateKey) : issuerPrivateKey;
    if (prv.length !== 32) throw new Error("issuer private key must be 32 bytes");
    return new CredentialIssuer(eddsa, poseidon, poseidon.F, prv);
  }

  private H(xs: bigint[]): bigint {
    return this.F.toObject(this.poseidon(xs));
  }

  /** The issuer's BabyJubJub public key + its key id (registered in issuer_registry). */
  pubkey(): { ax: bigint; ay: bigint; keyId: bigint } {
    const p = this.eddsa.prv2pub(this.prv);
    const ax = this.F.toObject(p[0]);
    const ay = this.F.toObject(p[1]);
    return { ax, ay, keyId: this.H([ax, ay]) };
  }

  /** Sign a tiered KYC credential bound to `holderBinding`. */
  issue(opts: {
    holderBinding: bigint;
    tier: AssuranceTier;
    expiry: bigint;
    serial: bigint;
    attrHash?: bigint;
  }): IssuedCredential {
    const { ax, ay, keyId } = this.pubkey();
    const credType = BigInt(opts.tier);
    const attrHash = opts.attrHash ?? 0n;
    const msg = this.poseidon([attrHash, opts.holderBinding, keyId, opts.expiry, credType, opts.serial]);
    const sig = this.eddsa.signPoseidon(this.prv, msg);
    return {
      issuerAx: ax,
      issuerAy: ay,
      issuerKeyId: keyId,
      sigS: sig.S,
      sigR8x: this.F.toObject(sig.R8[0]),
      sigR8y: this.F.toObject(sig.R8[1]),
      addressBinding: opts.holderBinding,
      credType,
      expiry: opts.expiry,
      serial: opts.serial,
      attrHash,
    };
  }

  /** Verify an issued credential's signature (the circuit does this in-ZK). */
  verify(c: IssuedCredential): boolean {
    const msg = this.poseidon([c.attrHash, c.addressBinding, c.issuerKeyId, c.expiry, c.credType, c.serial]);
    const A = [this.F.e(c.issuerAx), this.F.e(c.issuerAy)];
    const sig = { R8: [this.F.e(c.sigR8x), this.F.e(c.sigR8y)], S: c.sigS };
    return this.eddsa.verifyPoseidon(msg, sig, A);
  }
}
