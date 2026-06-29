/**
 * Account-bearing client-side reads - the shielded balance + history read
 * DIRECTLY from the chain in the browser, with NO BFF in the read path. This is
 * the core of "the blockchain is the backend": the device holds the account
 * (viewing + spend keys), constructs a BenzoClient over StellarRpcClient + the
 * note scanner, syncs the pool from the Soroban RPC, trial-decrypts its own
 * notes, and sums the spendable balance - all on-device.
 *
 * Key provenance: in hosted deployments the account must be derived from the
 * passkey/zk-login material on the device and never leave it. For local testnet
 * development only, /api/dev/account can be enabled with BENZO_DEV_EXPORT=1 as
 * the one-time "migrate file-custody → device-custody" step. If that endpoint is
 * disabled, this returns null and the caller falls back to the BFF read; nothing
 * breaks.
 */
import {
  BenzoClient,
  StellarRpcClient,
  pickBrowserProver,
  MvkRegistryMirror,
  createAccount,
  fromHex,
  fetchMvkRegistryLeaves,
  mvkRegistryLeaf,
} from "@benzo/core";
import { verifyBalanceProofOnChain } from "./chain";
import { RPC_URL, NETWORK_PASSPHRASE, SIM_SOURCE, DEPLOYMENT, RELAYER_ADDRESS, TEE_CONFIG } from "./network";
import { preferDeviceProving } from "./proverPolicy";
import { prepareApiRequest } from "./api";
import { hasPasskey, loginWithPasskey } from "./passkey";

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.slice(i, i + 0x8000));
  }
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Durable on-device key/value over IndexedDB, ENCRYPTED AT REST. Persists the
 * note-discovery snapshot + ASP set so the shielded read RESUMES incrementally
 * (warm read ~0.9s vs ~14s cold). The snapshot reveals which on-chain notes are
 * yours, so we AES-GCM seal every value under a key HKDF-derived from the
 * account's VIEWING secret - an attacker with device/disk access learns nothing
 * without the account. Fully client-side; nothing leaves the device. A value
 * that won't decrypt (e.g. different account) is treated as a cache miss → re-scan.
 */
class IdbKVStore {
  private db?: Promise<IDBDatabase>;
  private aes?: Promise<CryptoKey>;
  constructor(private readonly viewSecret: Uint8Array) {}
  private key(): Promise<CryptoKey> {
    if (!this.aes) {
      this.aes = (async () => {
        const base = await crypto.subtle.importKey("raw", this.viewSecret as BufferSource, "HKDF", false, ["deriveKey"]);
        return crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("benzo/idb/aes-gcm") },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      })();
    }
    return this.aes;
  }
  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = indexedDB.open("benzo-wallet", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.db;
  }
  async get(key: string): Promise<string | null> {
    const db = await this.open();
    const stored = await new Promise<string | null>((resolve, reject) => {
      const r = db.transaction("kv", "readonly").objectStore("kv").get(key);
      r.onsuccess = () => resolve((r.result as string | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
    if (!stored) return null;
    try {
      const [iv, ct] = stored.split(":");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await this.key(), unb64(ct));
      return new TextDecoder().decode(pt);
    } catch {
      return null; // undecryptable (wrong account / tamper) → cache miss, safe re-scan
    }
  }
  async set(key: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), new TextEncoder().encode(value)));
    const blob = `${b64(iv)}:${b64(ct)}`;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// Browser proving artifacts for local desktop proving (served from /public/circuits).
// snarkjs fetches these URLs only when pickBrowserProver chooses WasmProver; TEE
// routes use the circuit id and do not download zkeys.
const a = (c: string) => ({ wasmPath: `/circuits/${c}.wasm`, zkeyPath: `/circuits/${c}.zkey`, circuit: c });
// Only joinsplit (transfer) + proof_of_balance are served for on-device proving.
// shield/unshield are NOT wired client-side yet - they go through the BFF. Earlier
// these aliased proof_of_balance's artifacts "to satisfy the type", which would
// SILENTLY generate the WRONG proof if ever invoked. Instead, accessing their
// paths throws loudly so a miswire fails fast rather than producing a bad proof.
const notWired = (c: string) => ({
  get wasmPath(): string { throw new Error(`client-side ${c} proving is not wired yet - this op must use the BFF path`); },
  get zkeyPath(): string { throw new Error(`client-side ${c} proving is not wired yet - this op must use the BFF path`); },
  circuit: c,
});
const CIRCUITS = {
  shield: notWired("shield"),
  joinsplit: a("joinsplit"),
  unshield: notWired("unshield"),
  proofOfBalance: a("proof_of_balance"),
};

/** Resolve a source NAME to its public G-address (relayer vs read/sim source). */
const addressFor = (name: string): string => (name === "relayer" ? RELAYER_ADDRESS : SIM_SOURCE);

/** Hand a proven write (proof + public inputs, NEVER the witness) to the gas relay. */
async function submitWrite(opts: { contractId: string; source: string; fnArgs: string[] }) {
  const prepared = prepareApiRequest("/relay/submit", {
    method: "POST",
    body: JSON.stringify({ contractId: opts.contractId, fnArgs: opts.fnArgs }),
  });
  let res: Response | undefined;
  try {
    res = await fetch(prepared.url, prepared.init);
    if (!res.ok) throw new Error(`relay ${res.status}: ${(await res.json().catch(() => ({}))).error ?? ""}`);
    const j = (await res.json()) as { txHash?: string };
    return { txHash: j.txHash, result: j.txHash, raw: j.txHash ?? "" };
  } finally {
    if (res && res.status < 500) prepared.clearIdempotency?.();
  }
}

let cached: BenzoClient | null | undefined;

function canUseDevAccountExport(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

async function accountFromDevExport(): Promise<{ spendSk: string; viewSecret: string; mvkSecret: string } | null> {
  if (!canUseDevAccountExport()) return null;
  try {
    const prepared = prepareApiRequest("/dev/account");
    const r = await fetch(prepared.url, prepared.init);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function getClient(opts: { interactive?: boolean } = {}): Promise<BenzoClient | null> {
  if (cached !== undefined && (cached !== null || !opts.interactive)) return cached;
  const exported = await accountFromDevExport();
  const account = exported
    ? createAccount({
        label: "wallet",
        spendSk: BigInt(exported.spendSk),
        viewSecret: fromHex(exported.viewSecret),
        mvkSecret: fromHex(exported.mvkSecret),
      })
    : opts.interactive && hasPasskey()
      ? await loginWithPasskey()
      : null;
  if (!account) {
    return null;
  }
  const cli = new StellarRpcClient({
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    addressFor, // "relayer" → relay operator addr; else the read/sim source
    submitWrite, // writes are proven in-browser/TEE, then handed to the gas relay
  });
  const client = new BenzoClient({
    cli,
    deployment: DEPLOYMENT,
    circuits: CIRCUITS as never,
    prover: pickBrowserProver({
      mode: preferDeviceProving() ? "on-device" : "tee",
      tee: TEE_CONFIG ?? missingTee(),
    }),
    rpcUrl: RPC_URL,
    txSource: "sim",
    handleRegistry: DEPLOYMENT.handleRegistry,
    relayer: { source: "relayer", address: RELAYER_ADDRESS },
    store: new IdbKVStore(account.viewSecret), // encrypted at rest under the account's viewing key
  });
  client.useAccount(account);
  cached = client;
  return client;
}

let mvkWired = false;
/**
 * Mirror the on-chain MVK registry on-device (READ-ONLY) so spends produce a
 * `registeredMvkRoot` the pool accepts. The account's MVK is already registered
 * on-chain (from prior activity), so we only replay leaves - no write. Returns
 * false if this account's MVK isn't registered (then a client-side send isn't
 * possible without a register write - caller falls back to the BFF).
 */
async function wireMvkRegistry(client: BenzoClient): Promise<boolean> {
  if (mvkWired) return true;
  const leaves = await fetchMvkRegistryLeaves(RPC_URL, DEPLOYMENT.mvkRegistry, 1);
  const myLeaf = mvkRegistryLeaf(client.account.mvkScalar, 0n);
  if (!leaves.includes(myLeaf)) return false;
  const reg = new MvkRegistryMirror();
  reg.syncWithOwnedKey(leaves, client.account.mvkScalar, 0n);
  client.pool.useMvkRegistry(reg);
  mvkWired = true;
  return true;
}

/**
 * Client-controlled private send: the browser resolves the @handle, proves the
 * shielded transfer locally on capable desktops or in the attested TEE on weak
 * devices, and hands ONLY the proof + public inputs to the stateless gas relay
 * for submission. Returns the tx hash, or null if the device can't do it
 * (account not provisioned / MVK not registered) so the caller falls back.
 */
export async function sendClientSide(
  handle: string,
  amountStroops: string,
): Promise<{ txHash?: string; prover: "local" | "tee" } | null> {
  const c = await getClient({ interactive: true });
  if (!c) return null;
  await c.sync();
  if (!(await wireMvkRegistry(c))) return null;
  const sh = await c.sendToHandle({ handle: handle.replace(/^@/, ""), amount: BigInt(amountStroops), useRelayer: true });
  const r = await sh.settled();
  return { txHash: r?.txHash, prover: c.opts.prover.name === "phala" ? "tee" : "local" };
}

/** True when the device can read shielded state itself (account provisioned). */
export async function clientSideReadsAvailable(): Promise<boolean> {
  return (await getClient({ interactive: true })) !== null;
}

/**
 * Read the spendable shielded balance (stroops) DIRECTLY from chain, on-device.
 * Returns null if the account isn't provisioned (caller falls back to the BFF).
 */
export async function readShieldedBalanceClientSide(): Promise<string | null> {
  const c = await getClient();
  if (!c) return null;
  await c.sync();
  return (await c.getBalance()).toString();
}

/**
 * Client-controlled "prove your balance": the browser GENERATES the Groth16
 * proof-of-balance locally on capable desktops or in the attested TEE on weak
 * devices, then VERIFIES it on-chain itself. No BFF prover in the loop.
 * Returns { holds, onChain } or null if the device account isn't provisioned.
 */
export async function proveBalanceClientSide(
  minStroops: string,
): Promise<{ holds: boolean; onChain: boolean; provingMs?: number; verifyMs?: number } | null> {
  const c = await getClient({ interactive: true });
  if (!c) return null;
  // Time the two client-controlled phases so the proving claim is measurable:
  // (1) prove = local WASM or attested TEE; (2) verify = the proof checked
  // on-chain by the verifier.
  const t0 = performance.now();
  const r = await c.proveBalance({ minAmount: BigInt(minStroops) });
  const t1 = performance.now();
  const onChain = await verifyBalanceProofOnChain(r.sorobanProof, r.sorobanPublics);
  const t2 = performance.now();
  const provingMs = Math.round(t1 - t0);
  const verifyMs = Math.round(t2 - t1);
  console.info(`[benzo] client-side proof_of_balance: prove=${provingMs}ms verify(on-chain)=${verifyMs}ms`);
  return { holds: true, onChain, provingMs, verifyMs };
}

function missingTee(): never {
  throw new Error("No attested TEE prover is configured for this wallet build.");
}
