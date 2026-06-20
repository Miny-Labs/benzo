/**
 * @benzo/kyc — pluggable KYC provider for the anchor's on-ramp edge (SEP-12).
 *
 * STATUS for the hackathon: MOCK ONLY. `kycFromEnv()` returns MockKyc when no
 * key is set (the default), so NO real identity verification happens and NO PII
 * is collected — the testnet corridor runs entirely on the Mock. There is no
 * real KYC in this project.
 *
 * DiditKyc is an OPTIONAL, FUTURE sandbox integration kept behind the same
 * interface to show where regulated KYC would plug in. It only activates if you
 * deliberately set DIDIT_API_KEY. KYC, when real, must see PII at the regulated
 * fiat edge — it is custodial, off-chain, and NOT zero-knowledge (Benzo's ZK is
 * in the shielded notes, never the KYC).
 */

export * from "./issuer.js";
export * from "./zklogin.js";

export type KycStatus = "not_started" | "pending" | "approved" | "declined";

export interface KycSession {
  id: string;
  /** hosted verification URL the user is sent to */
  url: string;
}

export interface KycProvider {
  readonly name: string;
  /** Begin a verification for an opaque user reference; returns a hosted session. */
  start(userRef: string): Promise<KycSession>;
  /** Current decision for a session. */
  status(sessionId: string): Promise<KycStatus>;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

function mapDidit(s: string): KycStatus {
  switch ((s || "").toLowerCase().replace(/\s+/g, "_")) {
    case "approved": return "approved";
    case "declined":
    case "expired":
    case "abandoned": return "declined";
    case "in_review":
    case "pending": return "pending";
    default: return "not_started";
  }
}

/** Didit IDV (https://didit.me). Env: DIDIT_API_KEY, optional KYC_CALLBACK_URL. */
export class DiditKyc implements KycProvider {
  readonly name = "didit";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://verification.didit.me",
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly callbackUrl = process.env.KYC_CALLBACK_URL,
  ) {}

  async start(userRef: string): Promise<KycSession> {
    const r = await this.fetchImpl(`${this.baseUrl}/v1/session/`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ vendor_data: userRef, callback: this.callbackUrl }),
    });
    if (!r.ok) throw new Error(`didit start failed: ${r.status}`);
    const j = await r.json();
    return { id: j.session_id ?? j.id, url: j.url ?? j.verification_url };
  }

  async status(sessionId: string): Promise<KycStatus> {
    const r = await this.fetchImpl(`${this.baseUrl}/v1/session/${sessionId}/decision/`, {
      headers: { "x-api-key": this.apiKey },
    });
    if (!r.ok) throw new Error(`didit status failed: ${r.status}`);
    const j = await r.json();
    return mapDidit(j.status ?? j.decision?.status);
  }
}

/** Deterministic mock for testnet/sandbox without an API key. */
export class MockKyc implements KycProvider {
  readonly name = "mock";
  async start(userRef: string): Promise<KycSession> {
    return { id: `mock-${Buffer.from(userRef).toString("hex").slice(0, 12)}`, url: "https://mock.kyc/verify" };
  }
  /** Approves unless the session id contains "fail" (lets demos force a decline). */
  async status(sessionId: string): Promise<KycStatus> {
    return sessionId.includes("fail") ? "declined" : "approved";
  }
}

/** Pick a SEP-12 anchor-KYC provider from env: Didit when DIDIT_API_KEY is set, else Mock. */
export function kycFromEnv(env: NodeJS.ProcessEnv = process.env): KycProvider {
  return env.DIDIT_API_KEY ? new DiditKyc(env.DIDIT_API_KEY) : new MockKyc();
}

// ===========================================================================
// Tiered ZK identity (the NON-MOCK, in-protocol identity gate)
//
// Distinct from the SEP-12 anchor KYC above (which is custodial, off-chain, for
// the fiat edge). This is the privacy-preserving, risk-based identity model that
// gates the shielded pool: a user proves an ASSURANCE TIER in zero knowledge,
// and `admit_by_proof` enforces "this action needs tier >= N". Most transfers
// need only Tier 0/1 — we never force document KYC on a small private payment.
//
// The tier is carried in the credential's `credType` field, signed by the
// issuer and proven by the `kyc_credential` circuit, so the tier itself is
// authenticated and enforced on-chain.
// ===========================================================================

export enum AssuranceTier {
  /** no identity — receive, hold, small private transfers */
  ANONYMOUS = 0,
  /** a unique human (zkLogin / phone / Self humanity) — higher limits, sybil-safe */
  UNIQUE_HUMAN = 1,
  /** verified government ID (Self passport / national ID / Aadhaar) — large transfers, off-ramp */
  VERIFIED_ID = 2,
  /** verified ID + sanctions-clear + proof-of-funds — business / high value */
  FULL = 3,
}

/** A user meets a required tier iff their assurance is at least that high. */
export function meetsTier(have: AssuranceTier, need: AssuranceTier): boolean {
  return have >= need;
}

// ---------------------------------------------------------------------------
// Tier ↔ UI helpers (S2) — the single source of truth for "which action needs
// which tier", plus user-facing labels/messages. Both apps import these so the
// gate is consistent everywhere (a screen never hard-codes a tier number).
// USDC thresholds (small vs large send, ramp caps) are POLICY, applied by the
// BFF; this maps each named flow to its required in-protocol assurance tier.
// ---------------------------------------------------------------------------

export type BenzoFlow =
  // consumer (T0)
  | "view"
  | "receive"
  | "proveBalance"
  // consumer (gated)
  | "sendSmall"
  | "sendLarge"
  | "createInvite"
  | "claim"
  | "cashIn"
  | "cashOut"
  // business
  | "payrollRun"
  | "apPay"
  | "auditorGrant";

const FLOW_TIER: Record<BenzoFlow, AssuranceTier> = {
  view: AssuranceTier.ANONYMOUS,
  receive: AssuranceTier.ANONYMOUS,
  proveBalance: AssuranceTier.ANONYMOUS,
  sendSmall: AssuranceTier.UNIQUE_HUMAN,
  sendLarge: AssuranceTier.VERIFIED_ID,
  createInvite: AssuranceTier.UNIQUE_HUMAN,
  claim: AssuranceTier.UNIQUE_HUMAN,
  cashIn: AssuranceTier.VERIFIED_ID,
  cashOut: AssuranceTier.VERIFIED_ID,
  payrollRun: AssuranceTier.VERIFIED_ID,
  apPay: AssuranceTier.VERIFIED_ID,
  auditorGrant: AssuranceTier.VERIFIED_ID,
};

/** The assurance tier required to perform a named flow. */
export function tierForFlow(flow: BenzoFlow): AssuranceTier {
  return FLOW_TIER[flow];
}

/** A short, human label for a tier (for badges + step-up screens). */
export function tierLabel(tier: AssuranceTier): string {
  switch (tier) {
    case AssuranceTier.ANONYMOUS:
      return "Anonymous";
    case AssuranceTier.UNIQUE_HUMAN:
      return "Verified human";
    case AssuranceTier.VERIFIED_ID:
      return "ID-verified";
    case AssuranceTier.FULL:
      return "Fully verified";
  }
}

/**
 * A friendly, action-oriented message for a step-up — or null when the user
 * already meets the bar (caller can skip the gate). Privacy-forward copy: it
 * always reassures that the ID never goes on-chain.
 */
export function tierGapMessage(have: AssuranceTier, need: AssuranceTier): string | null {
  if (meetsTier(have, need)) return null;
  switch (need) {
    case AssuranceTier.UNIQUE_HUMAN:
      return "Quick check: confirm you're a real person to continue. No documents needed.";
    case AssuranceTier.VERIFIED_ID:
      return "Verify your ID once to do this. Your ID never goes on-chain.";
    case AssuranceTier.FULL:
      return "This needs full verification (ID plus business checks).";
    default:
      return `This action needs ${tierLabel(need)}.`;
  }
}

/** The outcome of a real identity verification, ready to re-issue as a credential. */
export interface IdentityVerification {
  tier: AssuranceTier;
  /** per-scope sybil nullifier (apply domain-separation before on-chain use) */
  nullifier: bigint;
  /** true iff the OFAC/sanctions checks are all clear */
  ofacClear: boolean;
  attributes?: { nationality?: string; olderThan?: number };
}

/** The slice of Self's `SelfBackendVerifier.verify(...)` result Benzo consumes. */
export interface SelfVerifyResult {
  isValid: boolean;
  /** 1=passport, 2=EU ID, 3=Aadhaar, 4=KYC attestation, 0/undefined=humanity-only */
  attestationId?: number;
  nullifier: bigint | string;
  /** OFAC results [passportNo, name+DOB, name+YOB]; all false = clear */
  ofac?: boolean[];
  olderThan?: number;
  nationality?: string;
}

export type SelfVerifyFn = (args: {
  attestationId: number;
  proof: unknown;
  publicSignals: unknown;
  userContextData: unknown;
}) => Promise<SelfVerifyResult>;

/** Map a verified Self result to a Benzo assurance tier. */
export function tierFromSelf(attestationId: number | undefined, ofacClear: boolean): AssuranceTier {
  const hasDocument = attestationId != null && attestationId >= 1 && attestationId <= 4;
  if (hasDocument) return ofacClear ? AssuranceTier.VERIFIED_ID : AssuranceTier.UNIQUE_HUMAN;
  return AssuranceTier.UNIQUE_HUMAN; // proof-of-human only (no document disclosed)
}

/**
 * Real Self-backed identity provider. The proof verification is the genuine
 * `@selfxyz/core` `SelfBackendVerifier` (injected as `verifyFn` so the package
 * stays decoupled + unit-testable); `selfVerifierFromEnv()` wires the real one.
 * `domainSep` re-keys Self's nullifier into a Benzo-domain value so the on-chain
 * `identity_nullifier_set` value can't be correlated back to the Self ecosystem.
 */
export class SelfIdentityProvider {
  readonly name = "self";
  constructor(
    private readonly verifyFn: SelfVerifyFn,
    private readonly domainSep: (rawNullifier: bigint) => bigint = (n) => n,
  ) {}

  async verify(args: {
    attestationId: number;
    proof: unknown;
    publicSignals: unknown;
    userContextData: unknown;
  }): Promise<IdentityVerification> {
    const r = await this.verifyFn(args);
    if (!r.isValid) throw new Error("self: proof is not valid");
    const ofacClear = (r.ofac ?? []).every((x) => x === false);
    const raw = typeof r.nullifier === "string" ? BigInt(r.nullifier) : r.nullifier;
    return {
      tier: tierFromSelf(r.attestationId, ofacClear),
      nullifier: this.domainSep(raw),
      ofacClear,
      attributes: { nationality: r.nationality, olderThan: r.olderThan },
    };
  }
}

/**
 * Build a `SelfVerifyFn` from the real `@selfxyz/core` SDK (lazy-imported so the
 * package builds/tests without it). Staging (testnet, mock passports) when
 * SELF_MOCK_PASSPORT!=="false". Throws a clear error if @selfxyz/core isn't
 * installed.
 */
export async function selfVerifierFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SelfVerifyFn> {
  let mod: any;
  try {
    mod = await import("@selfxyz/core");
  } catch {
    throw new Error("@selfxyz/core not installed — run `pnpm add @selfxyz/core` in @benzo/kyc to enable real Self verification");
  }
  const { SelfBackendVerifier, AllIds, DefaultConfigStore } = mod;
  const verifier = new SelfBackendVerifier(
    env.SELF_SCOPE ?? "benzo",
    env.SELF_ENDPOINT ?? "",
    env.SELF_MOCK_PASSPORT !== "false", // true = staging/testnet
    AllIds,
    new DefaultConfigStore({ minimumAge: 18, excludedCountries: [], ofac: true }),
    "hex",
  );
  return async ({ attestationId, proof, publicSignals, userContextData }) => {
    const res = await verifier.verify(attestationId, proof, publicSignals, userContextData);
    const d = res.isValidDetails ?? {};
    const disc = res.discloseOutput ?? res.credentialSubject ?? {};
    return {
      isValid: Boolean(res.isValid ?? d.isValid),
      attestationId,
      nullifier: disc.nullifier ?? "0",
      ofac: disc.ofac ?? [],
      olderThan: disc.olderThan,
      nationality: disc.nationality,
    };
  };
}
