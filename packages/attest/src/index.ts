/**
 * @benzo/attest — Benzo's native Stellar attestation layer (WS2) on top of
 * AttestProtocol (`@attestprotocol/stellar-sdk`, testnet contract
 * `CBFE5YSU…`). Publishes a "KYC verified at tier N" attestation natively on
 * Soroban that any dApp can check — the on-brand Stellar trust primitive,
 * complementing the in-protocol `issuer_registry`.
 *
 * Privacy note: a public on-chain attestation tied to a Stellar address is for
 * the TRANSPARENT surface (e.g. business/org gating, the issuer's own audit
 * trail) — NEVER the private shielded-admission path (which consumes credentials
 * in ZK to avoid deanonymizing the user). See docs/ZK-ARCHITECTURE.
 *
 * The AttestProtocol client is injected (structural `AttestClientLike`) so this
 * package is unit-testable without the SDK; `attestClientFromEnv()` wires the
 * real one.
 */

/** Benzo's KYC attestation schema (AttestProtocol struct syntax). */
export const BENZO_KYC_SCHEMA = "struct BenzoKYC { bool verified; u32 tier; u64 expiry; }";

/** The slice of `@attestprotocol/stellar-sdk` StellarAttestationClient we use. */
export interface AttestClientLike {
  generateSchemaUid(p: { definition: string; authority: string; resolver?: string }): unknown;
  createSchema(p: { definition: string; revocable?: boolean; options?: unknown }): Promise<unknown>;
  attest(p: {
    schemaUid: unknown;
    value: string;
    subject?: string;
    expirationTime?: number;
    options?: unknown;
  }): Promise<unknown>;
  getAttestation(uid: unknown): Promise<{ result?: unknown } | unknown>;
}

export interface KycAttestationValue {
  verified: boolean;
  tier: number;
  expiry: number;
}

export class BenzoAttestations {
  constructor(
    private readonly client: AttestClientLike,
    private readonly authority: string,
  ) {}

  /** Deterministic UID of Benzo's KYC schema (definition + authority). */
  schemaUid(): unknown {
    return this.client.generateSchemaUid({ definition: BENZO_KYC_SCHEMA, authority: this.authority });
  }

  /** Register the Benzo KYC schema on-chain (idempotent: UID is deterministic). */
  ensureSchema(signer: unknown): Promise<unknown> {
    return this.client.createSchema({ definition: BENZO_KYC_SCHEMA, revocable: true, options: { signer } });
  }

  /** Publish a "verified at tier N" attestation about `subject`. */
  attestKyc(opts: { subject: string; tier: number; expiry: number; signer: unknown }): Promise<unknown> {
    const value: KycAttestationValue = { verified: true, tier: opts.tier, expiry: opts.expiry };
    return this.client.attest({
      schemaUid: this.schemaUid(),
      value: JSON.stringify(value),
      subject: opts.subject,
      expirationTime: opts.expiry,
      options: { signer: opts.signer },
    });
  }

  /** Read + parse a KYC attestation by UID. */
  async readKyc(attestationUid: unknown): Promise<KycAttestationValue | null> {
    const a = (await this.client.getAttestation(attestationUid)) as { result?: { value?: string } } | undefined;
    const raw = a?.result?.value;
    return raw ? (JSON.parse(raw) as KycAttestationValue) : null;
  }
}

/**
 * Build a real AttestProtocol client (lazy-imports the SDK so the package builds
 * without it). Testnet contract `CBFE5YSUHCRYEYEOLNN2RJAWMQ2PW525KTJ6TPWPNS5XLIREZQ3NA4KP`.
 */
export async function attestClientFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<AttestClientLike> {
  let mod: { StellarAttestationClient: new (cfg: unknown) => AttestClientLike };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional dependency
    mod = await import("@attestprotocol/stellar-sdk");
  } catch {
    throw new Error("@attestprotocol/stellar-sdk not installed — run `pnpm add @attestprotocol/stellar-sdk` in @benzo/attest");
  }
  return new mod.StellarAttestationClient({
    rpcUrl: env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    network: (env.STELLAR_NETWORK as "testnet" | "mainnet") ?? "testnet",
    publicKey: env.DEPLOYER_PUBLIC ?? "",
  });
}
