/**
 * Node-only account file persistence (kept out of account.ts so the account
 * MODEL + login seam stay browser-portable). A browser surface persists keys
 * via the platform Keychain / KVStore instead of the filesystem.
 */

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
