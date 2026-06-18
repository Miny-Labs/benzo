/**
 * zkLogin — a passport-free **Tier-1 (unique-human)** identity path (WS3).
 *
 * Follows the Stellar-zkLogin semi-trusted model: the server verifies the user's
 * OAuth/OIDC token (Google/Apple) — real RSA-JWT verification against the
 * provider's JWKS, done off-circuit — then issues a Tier-1 credential the
 * `kyc_credential` circuit proves in ZK (via CredentialIssuer). So we get
 * document-free onboarding + sybil resistance without an in-circuit RSA proof.
 *
 * The sybil nullifier is derived from (issuer, subject) so one OAuth identity
 * maps to one account, then domain-separated so it can't be correlated to the
 * OAuth provider on-chain.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { AssuranceTier, type IdentityVerification } from "./index.js";

/** BN254 scalar field order — the nullifier must be a field element. */
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface OidcClaims {
  /** stable per-provider user id */
  sub: string;
  /** the OAuth client id this token was issued for */
  aud: string;
  /** the provider, e.g. "https://accounts.google.com" */
  iss: string;
  email?: string;
}

/** Verify an OIDC JWT and return its claims (real impl checks the provider JWKS). */
export type JwtVerifyFn = (jwt: string) => Promise<OidcClaims>;

export class ZkLoginProvider {
  readonly name = "zklogin";
  constructor(
    private readonly verifyJwt: JwtVerifyFn,
    private readonly expectedAud: string,
    private readonly domainSep: (raw: bigint) => bigint = (n) => n,
  ) {}

  async verify(jwt: string): Promise<IdentityVerification> {
    const c = await this.verifyJwt(jwt);
    if (c.aud !== this.expectedAud) {
      throw new Error(`zklogin: token audience mismatch (got "${c.aud}")`);
    }
    // One account per OAuth identity per provider; reduced into the BN254 field.
    const digest = BigInt("0x" + bytesToHex(sha256(utf8ToBytes(`${c.iss}|${c.sub}`))));
    const raw = digest % BN254_R;
    return {
      tier: AssuranceTier.UNIQUE_HUMAN,
      nullifier: this.domainSep(raw),
      ofacClear: true, // social login carries no sanctions signal; OFAC is a Tier-2 concern
      attributes: {},
    };
  }
}

/**
 * Real Google OIDC verifier (lazy-imports `jose` so the package builds without
 * it). Verifies signature against Google's JWKS + issuer + expiry.
 */
export async function googleJwtVerifier(clientId: string): Promise<JwtVerifyFn> {
  let jose: any;
  try {
    jose = await import("jose");
  } catch {
    throw new Error("jose not installed — run `pnpm add jose` in @benzo/kyc to enable Google zkLogin");
  }
  const JWKS = jose.createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return async (jwt: string) => {
    const { payload } = await jose.jwtVerify(jwt, JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    return { sub: String(payload.sub), aud: String(payload.aud), iss: String(payload.iss), email: payload.email as string | undefined };
  };
}
