/**
 * SEP-10 challenge construction and **cryptographic** verification.
 *
 * The challenge is a Stellar transaction whose source is the anchor's
 * SIGNING_KEY and whose first operation is a `manageData` whose source is the
 * authenticating client account. The anchor signs it; the client counter-signs
 * the exact bytes; the anchor then verifies BOTH signatures over the
 * transaction hash before issuing a JWT.
 *
 * This replaces a prior signature-count heuristic with real Ed25519
 * verification against the public keys — a forged or missing server/client
 * signature is rejected.
 */

import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

export interface ChallengeParams {
  signingKeypair: Keypair; // the anchor's SIGNING_KEY (secret)
  clientAccount: string; // G... of the authenticating user
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  nonce: string; // 48+ bytes of base64 entropy (per SEP-10)
  now: number; // unix seconds
  timeoutSecs?: number;
}

/** Build and server-sign a SEP-10 challenge transaction; returns its XDR. */
export function buildChallenge(p: ChallengeParams): string {
  // SEP-10 requires a sequence number of 0 on the challenge.
  const src = new Account(p.signingKeypair.publicKey(), "-1");
  const tx = new TransactionBuilder(src, {
    fee: "100",
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: p.now, maxTime: p.now + (p.timeoutSecs ?? 900) },
  })
    .addOperation(
      Operation.manageData({
        name: `${p.homeDomain} auth`,
        value: p.nonce,
        source: p.clientAccount,
      }),
    )
    .addOperation(
      Operation.manageData({
        name: "web_auth_domain",
        value: p.webAuthDomain,
        source: p.signingKeypair.publicKey(),
      }),
    )
    .build();
  tx.sign(p.signingKeypair);
  return tx.toXDR();
}

/** Verify one signer's Ed25519 signature over the tx hash (by key hint). */
function verifiesFor(tx: Transaction, publicKey: string): boolean {
  let kp: Keypair;
  try {
    kp = Keypair.fromPublicKey(publicKey);
  } catch {
    return false;
  }
  const hash = tx.hash();
  const hint = kp.signatureHint();
  for (const ds of tx.signatures) {
    if (Buffer.compare(Buffer.from(ds.hint()), Buffer.from(hint)) !== 0) continue;
    if (kp.verify(hash, Buffer.from(ds.signature()))) return true;
  }
  return false;
}

export interface VerifyResult {
  ok: boolean;
  clientAccount?: string;
  reason?: string;
}

/**
 * Verify a returned SEP-10 challenge. Checks (in order):
 *  1. the transaction parses and its source is the anchor SIGNING_KEY;
 *  2. the first operation is a manageData whose source is the client account;
 *  3. the **server** signature verifies against SIGNING_KEY (Ed25519);
 *  4. the **client** signature verifies against the client account (Ed25519).
 * Any failure returns `{ ok: false }` with a reason.
 */
export function verifyChallenge(
  xdr: string,
  signingPublicKey: string,
  networkPassphrase: string,
): VerifyResult {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction;
  } catch {
    return { ok: false, reason: "unparseable transaction" };
  }

  if (tx.source !== signingPublicKey) {
    return { ok: false, reason: "challenge source is not the anchor signing key" };
  }

  const op = tx.operations[0];
  if (!op || op.type !== "manageData" || !op.source) {
    return { ok: false, reason: "missing client manageData operation" };
  }
  const clientAccount = op.source;

  if (!verifiesFor(tx, signingPublicKey)) {
    return { ok: false, reason: "server signature invalid or missing" };
  }
  if (!verifiesFor(tx, clientAccount)) {
    return { ok: false, reason: "client signature invalid or missing" };
  }
  return { ok: true, clientAccount };
}
