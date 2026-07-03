import { IndexedDbKVStore, Keychain, passphraseWrappingKey, prfWrappingKey, newSalt } from "@benzo/wallet";
import { createAccount, accountFromSignedMessage, type BenzoAccount } from "@benzo/core";
import { StrKey } from "@stellar/stellar-sdk";
import { derivePasskeySecret, registerPasskey, createDeviceAuthProof } from "./passkey";
import { api } from "./api";

export interface WalletSecrets {
  stellarSecret: string;
  orgSpendId: string;
  mvkSeedHex: string;
}

let activeKeychain: Keychain | null = null;
let activeAccount: BenzoAccount | null = null;

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function getStore(): Promise<IndexedDbKVStore> {
  return IndexedDbKVStore.open("benzo-wallet", "keychain");
}

export async function walletExists(): Promise<boolean> {
  const kv = await getStore();
  return Keychain.exists(kv);
}

export function getLocalAccount(): BenzoAccount | null {
  return activeAccount;
}

export function isWalletUnlocked(): boolean {
  return activeAccount !== null;
}

async function loginDeviceBff() {
  const account = getLocalAccount();
  if (!account) return;
  try {
    const proof = createDeviceAuthProof(account, { ttlSeconds: 86400 * 7 });
    const res = await api.deviceAuth(proof);
    localStorage.setItem("benzo.googleCredential", res.token);
    // Dispatch auth changed event so components react
    window.dispatchEvent(new Event("benzo:auth-changed"));
  } catch (e) {
    console.error("Failed to authenticate local wallet with BFF:", e);
  }
}

export async function createWallet(passphrase: string): Promise<BenzoAccount> {
  const kv = await getStore();
  const salt = newSalt();
  await kv.set("benzo/keychain/v1/salt", salt);

  const wrappingKey = passphraseWrappingKey(passphrase, salt);
  const masterSeed = crypto.getRandomValues(new Uint8Array(32));
  const account = accountFromSignedMessage(masterSeed);

  const secrets: WalletSecrets = {
    stellarSecret: account.stellarSecret!,
    orgSpendId: account.spendSk.toString(),
    mvkSeedHex: toHex(masterSeed),
  };

  activeKeychain = await Keychain.create({ kv, wrappingKey, secrets, overwrite: true });
  activeAccount = account;

  // Save auto-lock state
  localStorage.setItem("benzo.wallet.type", "passphrase");
  await loginDeviceBff();
  return account;
}

export async function createWalletWithPasskey(userName: string): Promise<BenzoAccount> {
  const kv = await getStore();
  await registerPasskey({ userName, displayName: userName });

  const prfOutput = await derivePasskeySecret();
  const wrappingKey = prfWrappingKey(prfOutput);

  const masterSeed = crypto.getRandomValues(new Uint8Array(32));
  const account = accountFromSignedMessage(masterSeed);

  const secrets: WalletSecrets = {
    stellarSecret: account.stellarSecret!,
    orgSpendId: account.spendSk.toString(),
    mvkSeedHex: toHex(masterSeed),
  };

  activeKeychain = await Keychain.create({ kv, wrappingKey, secrets, overwrite: true });
  activeAccount = account;

  localStorage.setItem("benzo.wallet.type", "passkey");
  await loginDeviceBff();
  return account;
}

export async function unlockWallet(passphrase: string): Promise<BenzoAccount> {
  const kv = await getStore();
  const salt = await kv.get("benzo/keychain/v1/salt");
  if (!salt) throw new Error("Wallet salt not found. Try importing your wallet.");

  const wrappingKey = passphraseWrappingKey(passphrase, salt);
  const kc = await Keychain.unlock({ kv, wrappingKey });
  const masterSeed = fromHex(kc.secrets.mvkSeedHex);
  const account = accountFromSignedMessage(masterSeed);

  activeKeychain = kc;
  activeAccount = account;
  await loginDeviceBff();
  return account;
}

export async function unlockWalletWithPasskey(): Promise<BenzoAccount> {
  const kv = await getStore();
  const prfOutput = await derivePasskeySecret();
  const wrappingKey = prfWrappingKey(prfOutput);

  const kc = await Keychain.unlock({ kv, wrappingKey });
  const masterSeed = fromHex(kc.secrets.mvkSeedHex);
  const account = accountFromSignedMessage(masterSeed);

  activeKeychain = kc;
  activeAccount = account;
  await loginDeviceBff();
  return account;
}

export function lockWallet(): void {
  if (activeKeychain) {
    activeKeychain.lock();
  }
  activeKeychain = null;
  activeAccount = null;
  localStorage.removeItem("benzo.googleCredential");
}

export async function exportWallet(): Promise<string> {
  if (!activeKeychain) throw new Error("Wallet is locked");
  return JSON.stringify(activeKeychain.secrets, null, 2);
}

export async function importWallet(importedText: string, passphrase?: string): Promise<BenzoAccount> {
  const kv = await getStore();
  let secrets: WalletSecrets;

  const cleanText = importedText.trim();
  if (cleanText.startsWith("{")) {
    secrets = JSON.parse(cleanText) as WalletSecrets;
  } else if (cleanText.startsWith("S") && cleanText.length === 56) {
    const seedBytes = new Uint8Array(StrKey.decodeEd25519SecretSeed(cleanText));
    const account = accountFromSignedMessage(seedBytes);
    secrets = {
      stellarSecret: account.stellarSecret!,
      orgSpendId: account.spendSk.toString(),
      mvkSeedHex: toHex(seedBytes),
    };
  } else {
    throw new Error("Invalid import format. Provide raw secrets JSON or a Stellar secret seed starting with 'S'.");
  }

  // Determine wrapping mechanism
  if (passphrase) {
    const salt = newSalt();
    await kv.set("benzo/keychain/v1/salt", salt);
    const wrappingKey = passphraseWrappingKey(passphrase, salt);
    activeKeychain = await Keychain.create({ kv, wrappingKey, secrets, overwrite: true });
    localStorage.setItem("benzo.wallet.type", "passphrase");
  } else {
    // If no passphrase is provided, we default to using/registering a passkey
    await registerPasskey({ userName: "imported-wallet" });
    const prfOutput = await derivePasskeySecret();
    const wrappingKey = prfWrappingKey(prfOutput);
    activeKeychain = await Keychain.create({ kv, wrappingKey, secrets, overwrite: true });
    localStorage.setItem("benzo.wallet.type", "passkey");
  }

  const masterSeed = fromHex(secrets.mvkSeedHex);
  const account = accountFromSignedMessage(masterSeed);
  activeAccount = account;
  await loginDeviceBff();
  return account;
}

export async function deleteWallet(): Promise<void> {
  const kv = await getStore();
  if (activeKeychain) {
    await activeKeychain.wipe();
  } else {
    const kc = await Keychain.unlock({ kv, wrappingKey: new Uint8Array(32) }).catch(() => null);
    if (kc) await kc.wipe();
    else await kv.delete("benzo/keychain/v1");
  }
  await kv.delete("benzo/keychain/v1/salt");
  localStorage.removeItem("benzo.wallet.type");
  lockWallet();
}

export function getLocalAccountSummary() {
  if (!activeAccount) return null;
  return {
    address: activeAccount.stellarAddress,
    spendPub: activeAccount.spendPub.toString(),
    mvkPub: toHex(activeAccount.mvkPub),
  };
}
