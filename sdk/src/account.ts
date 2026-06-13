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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
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

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

interface AccountFile {
  label: string;
  spendSk: string;
  mvkSecret: string;
  viewSecret: string;
  stellarSecret?: string;
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
  let stellarSecret = opts.stellarSecret;
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

export function saveAccount(account: BenzoAccount, path: string): void {
  const file: AccountFile = {
    label: account.label,
    spendSk: account.spendSk.toString(),
    mvkSecret: hex(account.mvkSecret),
    viewSecret: hex(account.viewSecret),
    stellarSecret: account.stellarSecret,
  };
  writeFileSync(path, JSON.stringify(file, null, 2));
}

export function loadAccount(path: string): BenzoAccount {
  const file = JSON.parse(readFileSync(path, "utf8")) as AccountFile;
  return createAccount({
    label: file.label,
    spendSk: BigInt(file.spendSk),
    mvkSecret: unhex(file.mvkSecret),
    viewSecret: unhex(file.viewSecret),
    stellarSecret: file.stellarSecret,
  });
}

/** Load the account at `path`, or create+save a fresh one if absent. */
export function createOrLoadAccountFile(
  path: string,
  opts: { label?: string; stellarSecret?: string } = {},
): { account: BenzoAccount; created: boolean } {
  if (existsSync(path)) return { account: loadAccount(path), created: false };
  const account = createAccount(opts);
  saveAccount(account, path);
  return { account, created: true };
}
