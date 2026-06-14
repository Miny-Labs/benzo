/**
 * Node-only account file persistence (kept out of account.ts so the account
 * MODEL + login seam stay browser-portable). A browser surface persists keys
 * via the platform Keychain / KVStore instead of the filesystem.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type BenzoAccount, createAccount } from "./account.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

interface AccountFile {
  label: string;
  spendSk: string;
  mvkSecret: string;
  viewSecret: string;
  stellarSecret?: string;
}

interface EncryptedFile {
  benzoEncrypted: 1;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

/** AES-256-GCM encrypt the account JSON under a scrypt-derived key. */
function encrypt(json: string, passphrase: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const blob: EncryptedFile = {
    benzoEncrypted: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ct: ct.toString("hex"),
  };
  return JSON.stringify(blob);
}

function decrypt(blob: EncryptedFile, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, "hex"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ct, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Persist an account. When `passphrase` (or BENZO_PASSPHRASE) is set, the file
 * is AES-256-GCM encrypted at rest under a scrypt-derived key; otherwise it is
 * written as plaintext JSON (back-compatible). The spend/MVK/view secrets and
 * the Stellar secret should never sit in plaintext for a real user.
 */
export function saveAccount(
  account: BenzoAccount,
  path: string,
  passphrase = process.env.BENZO_PASSPHRASE,
): void {
  const file: AccountFile = {
    label: account.label,
    spendSk: account.spendSk.toString(),
    mvkSecret: hex(account.mvkSecret),
    viewSecret: hex(account.viewSecret),
    stellarSecret: account.stellarSecret,
  };
  const json = JSON.stringify(file, null, 2);
  writeFileSync(path, passphrase ? encrypt(json, passphrase) : json);
}

export function loadAccount(
  path: string,
  passphrase = process.env.BENZO_PASSPHRASE,
): BenzoAccount {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as AccountFile | EncryptedFile;
  let file: AccountFile;
  if ((parsed as EncryptedFile).benzoEncrypted === 1) {
    if (!passphrase) {
      throw new Error("account file is encrypted — set BENZO_PASSPHRASE to unlock it");
    }
    file = JSON.parse(decrypt(parsed as EncryptedFile, passphrase)) as AccountFile;
  } else {
    file = parsed as AccountFile;
  }
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
