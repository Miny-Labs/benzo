/**
 * Benzo account — the key bundle a wallet holds. UI-facing: a frontend calls
 * `BenzoClient.createOrLoadAccount()` and never touches these internals.
 *
 * An account separates three authorities (BENZO.md §4.3 / §7):
 *  - spend key (BN254 scalar): authorizes spending notes (nullifier secret)
 *  - master viewing key (X25519): binds notes for selective disclosure (MVK)
 *  - note-discovery key (X25519): scans/decrypts incoming note ciphertexts
 * Optionally a Stellar Ed25519 key for the public on/off-ramp edges
 * (SEP-10 auth, receiving unshielded USDC). Contracts stay auth-agnostic.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { FIELD_MODULUS } from "./crypto/poseidon2.js";
import {
  deriveKeypair,
  randomFieldElement,
} from "./notes.js";
import {
  generateViewingKeypair,
  viewingKeypairFromSecret,
  viewingPubToScalar,
} from "./viewkeys.js";

export interface BenzoAccount {
  label: string;
  spendSk: bigint;
  spendPub: bigint;
  mvkSecret: Uint8Array;
  mvkPub: Uint8Array;
  mvkScalar: bigint;
  viewSecret: Uint8Array;
  viewPub: Uint8Array;
  /** optional Stellar Ed25519 identity for public edges */
  stellarSecret?: string;
  stellarAddress?: string;
}

export function createAccount(opts: {
  label?: string;
  spendSk?: bigint;
  mvkSecret?: Uint8Array;
  viewSecret?: Uint8Array;
  stellarSecret?: string;
} = {}): BenzoAccount {
  const spendSk = opts.spendSk ?? randomFieldElement();
  const kp = deriveKeypair(spendSk);
  const mvk = opts.mvkSecret ? viewingKeypairFromSecret(opts.mvkSecret) : generateViewingKeypair();
  const view = opts.viewSecret ? viewingKeypairFromSecret(opts.viewSecret) : generateViewingKeypair();
  const stellarSecret = opts.stellarSecret;
  let stellarAddress: string | undefined;
  if (stellarSecret) stellarAddress = StellarKeypair.fromSecret(stellarSecret).publicKey();
  return {
    label: opts.label ?? "benzo-account",
    spendSk,
    spendPub: kp.publicKey,
    mvkSecret: mvk.secret,
    mvkPub: mvk.publicKey,
    mvkScalar: viewingPubToScalar(mvk.publicKey),
    viewSecret: view.secret,
    viewPub: view.publicKey,
    stellarSecret,
    stellarAddress,
  };
}

/**
 * Deterministically derive a full Benzo account from a claim secret (the
 * payload of a claim link). Anyone holding the secret reconstructs the exact
 * same spend/MVK/view keys and can therefore discover and spend the note that
 * was sent to this account — the basis of send-to-link.
 */
export function accountFromClaimSecret(secret: Uint8Array): BenzoAccount {
  const spendOkm = hkdf(sha256, secret, undefined, "benzo/claim/spend", 32);
  const spendSk = BigInt("0x" + Buffer.from(spendOkm).toString("hex")) % FIELD_MODULUS;
  const mvkSecret = new Uint8Array(hkdf(sha256, secret, undefined, "benzo/claim/mvk", 32));
  const viewSecret = new Uint8Array(hkdf(sha256, secret, undefined, "benzo/claim/view", 32));
  return createAccount({ label: "claim", spendSk, mvkSecret, viewSecret });
}

/** The exact message a wallet signs once to derive Benzo's shielded note keys. */
export const NOTE_KEY_MESSAGE = "BENZO-NOTE-KEY-v1";

/**
 * Derive a full Benzo account (spend + viewing keys) from a SINGLE wallet
 * signature over NOTE_KEY_MESSAGE — the Railgun pattern. This is the piece no
 * embedded-wallet SDK (Dynamic/Privy/Para) provides: those manage only the
 * ed25519 SIGNING key, while Benzo's note keys are a separate layer. The user
 * signs `NOTE_KEY_MESSAGE` once; the same signature deterministically recovers
 * the same shielded account on any device — no second seed phrase.
 */
export function accountFromSignedMessage(signature: Uint8Array, label = "wallet"): BenzoAccount {
  const spendOkm = hkdf(sha256, signature, undefined, "benzo/notekey/spend", 32);
  const spendSk = BigInt("0x" + Buffer.from(spendOkm).toString("hex")) % FIELD_MODULUS;
  const mvkSecret = new Uint8Array(hkdf(sha256, signature, undefined, "benzo/notekey/mvk", 32));
  const viewSecret = new Uint8Array(hkdf(sha256, signature, undefined, "benzo/notekey/view", 32));
  return createAccount({ label, spendSk, mvkSecret, viewSecret });
}

/** A wallet's message-signing function (Dynamic/Privy/Para/passkey all expose one). */
export type SignMessage = (message: string) => Promise<Uint8Array> | Uint8Array;

/**
 * The headless login seam: turn ANY wallet's signer into a Benzo shielded
 * account. The user signs NOTE_KEY_MESSAGE once and `accountFromSignedMessage`
 * deterministically derives the spend/MVK/view keys — same account on every
 * device, no second seed phrase.
 *
 * This is the integration point for embedded-wallet logins. Dynamic is the
 * recommended Tier-1 Stellar provider (Privy/Para/passkeys also work): the
 * frontend obtains the wallet, gets its `signMessage`, and calls this. Nothing
 * here is frontend-specific — the signer is injected — so the seam is built and
 * testable now and the UI simply supplies the signer later.
 */
export async function loginWithSigner(signMessage: SignMessage, label = "wallet"): Promise<BenzoAccount> {
  const sig = await signMessage(NOTE_KEY_MESSAGE);
  return accountFromSignedMessage(sig instanceof Uint8Array ? sig : new Uint8Array(sig), label);
}
