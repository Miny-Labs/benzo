import type { Clipboard, IBenzoPlatform, KVStorage, Keychain } from "@benzo/platform";
import { WasmProver, type ProverPort } from "@benzo/prover";

/**
 * Web surface adapter (IBenzoPlatform) for the Benzo PWA.
 *
 *  - storage: IndexedDB — durable across reloads, so the incremental
 *    note-discovery snapshot + transaction journal survive (the in-memory
 *    fallback would force a full re-scan every load).
 *  - keychain: secrets are AES-256-GCM wrapped under a NON-EXTRACTABLE WebCrypto
 *    key kept in IndexedDB, so the spend/note secrets are never stored in the
 *    clear (XSS can't exfiltrate the wrapping key). A passkey-PRF-derived key is
 *    the production upgrade.
 *  - prover: WasmProver (client-side Groth16 — the witness never leaves the
 *    device).
 */

const DB_NAME = "benzo";
const DB_VERSION = 1;
const STORE_KV = "kv";
const STORE_SECRETS = "secrets";
const STORE_KEYS = "keys";
const WRAP_KEY_ID = "secret-wrap-key";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_SECRETS)) db.createObjectStore(STORE_SECRETS);
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsync<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await reqAsync(db.transaction(store, "readonly").objectStore(store).get(key));
  } finally {
    db.close();
  }
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await reqAsync(db.transaction(store, "readwrite").objectStore(store).put(value, key));
  } finally {
    db.close();
  }
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  try {
    await reqAsync(db.transaction(store, "readwrite").objectStore(store).delete(key));
  } finally {
    db.close();
  }
}

class IndexedDbStorage implements KVStorage {
  async get(key: string): Promise<string | null> {
    return (await idbGet<string>(STORE_KV, key)) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await idbPut(STORE_KV, key, value);
  }
  async remove(key: string): Promise<void> {
    await idbDelete(STORE_KV, key);
  }
}

/** Lazily get-or-create the non-extractable AES-GCM key that wraps secrets. */
async function wrapKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(STORE_KEYS, WRAP_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await idbPut(STORE_KEYS, WRAP_KEY_ID, key); // CryptoKey persists; non-extractable
  return key;
}

interface SealedSecret {
  iv: number[];
  ct: number[];
}

class WrappedKeychain implements Keychain {
  async getSecret(key: string): Promise<string | null> {
    const sealed = await idbGet<SealedSecret>(STORE_SECRETS, key);
    if (!sealed) return null;
    const k = await wrapKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(sealed.iv) },
      k,
      new Uint8Array(sealed.ct),
    );
    return new TextDecoder().decode(pt);
  }
  async setSecret(key: string, value: string): Promise<void> {
    const k = await wrapKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      k,
      new TextEncoder().encode(value),
    );
    const sealed: SealedSecret = { iv: [...iv], ct: [...new Uint8Array(ct)] };
    await idbPut(STORE_SECRETS, key, sealed);
  }
}

export class WebPlatform implements IBenzoPlatform {
  readonly name = "web";
  readonly prover: ProverPort = new WasmProver();
  readonly storage: KVStorage = new IndexedDbStorage();
  readonly keychain: Keychain = new WrappedKeychain();
  readonly clipboard: Clipboard = {
    read: () => navigator.clipboard.readText(),
    write: (text) => navigator.clipboard.writeText(text),
  };
  async openLink(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
