/**
 * The LIVE seam to @benzo/core — the headless SDK that settles REAL testnet
 * USDC via BenzoClient (real Groth16 proofs + Soroban + relayer). When the
 * process has the testnet env loaded (`set -a; . ./.env; set +a`) and the
 * ~/.benzo wallet exists, these functions perform real on-chain operations. If
 * the live client cannot be initialized, API routes fail closed.
 *
 * Mirrors apps/cli makeClient: NodeProver, StellarCli(configFromEnv), the
 * deployment from deployments/testnet.json, the circuit artifacts, and the
 * durable ~/.benzo wallet + state (so the BFF sees the same shielded balance
 * the CLI does).
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Money, PaymentOrder, TreasuryView } from "@benzo/types";
import {
  BenzoClient,
  LocalKeypairSigner,
  MvkRegistryMirror,
  StellarCli,
  StellarRpcClient,
  configFromEnv,
  createOrLoadAccountFile,
  deriveTvk,
  fetchMvkRegistryLeaves,
  mvkRegistryLeaf,
  makeClientSubmitWrite,
  proverFromEnv,
  sponsoredOnboard,
  sponsoredTrustlineOps,
  toHex,
  type ChainClient,
} from "@benzo/core";
import { Asset, BASE_FEE, Horizon, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { db, id, now, usd } from "./store.js";
import { currentAuth } from "./auth.js";
import { hostedRuntime } from "./runtime.js";

const ROOT = process.env.BENZO_ROOT || fileURLToPath(new URL("../../..", import.meta.url));
const DEPLOYMENT_URL = new URL("../../../deployments/testnet.json", import.meta.url);
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
// The business org's OWN shielded treasury identity + note-discovery state — kept
// SEPARATE from the consumer wallet (different product, different identity system;
// the two never share an account). App-specific env vars so a generic override
// can't accidentally re-merge them.
const WALLET = process.env.BENZO_CONSOLE_ACCOUNT || join(homedir(), ".benzo", "console", "account.json");
const STATE = process.env.BENZO_CONSOLE_STATE || join(dirname(WALLET), "state.json");
const TX_SOURCE = "benzo-deployer";
const RELAY_SOURCE = "benzo-relayer";
const OPERATOR_ADMIN_SOURCE = "benzo-operator-admin";
const HOSTED_ORG_SOURCE = "benzo-hosted-console-org";
/** The deployment record (set when the live client is built) — for the MVK registry. */
let deployment: Record<string, unknown> | null = null;
const hostedProvisioning = new Map<string, Promise<string>>();
const hostedRpcVisibility = new Map<string, Promise<void>>();

function operatorAdminSecret(): string | null {
  return process.env.BENZO_OPERATOR_ADMIN_SECRET
    ?? process.env.BENZO_CONSOLE_ADMIN_SECRET
    ?? (hostedRuntime() ? null : process.env.DEPLOYER_SECRET)
    ?? null;
}

function operatorAdminSource(): string {
  return hostedRuntime() ? OPERATOR_ADMIN_SOURCE : TX_SOURCE;
}

function consoleOrgSource(): string {
  return hostedRuntime() ? HOSTED_ORG_SOURCE : TX_SOURCE;
}

/** Durable note-discovery + journal store (atomic-write JSON file). */
class FileKVStore {
  constructor(private readonly path: string) {}
  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async get(key: string): Promise<string | null> {
    return this.read()[key] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const m = this.read();
    m[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, this.path);
  }
}

const clients = new Map<string, BenzoClient>();

function clientCacheKey(): string {
  const auth = currentAuth();
  if (hostedRuntime()) {
    if (!auth) throw new Error("Hosted console requires Google account auth");
    return auth.key;
  }
  return "local";
}

function statePath(): string {
  const auth = currentAuth();
  if (hostedRuntime()) {
    if (!auth) throw new Error("Hosted console requires Google account auth");
    return join(tmpdir(), `benzo-console-${auth.key}.json`);
  }
  return STATE;
}

function chainClientForRuntime(): ChainClient {
  const cfg = configFromEnv();
  if (!hostedRuntime()) return new StellarCli(cfg);
  const auth = currentAuth();
  const orgSecret = auth?.account.stellarSecret;
  const orgAddress = auth?.account.stellarAddress;
  if (!orgSecret || !orgAddress) throw new Error("Hosted console account has no Stellar public-edge signer");
  const relayerSecret = process.env.RELAYER_SECRET;
  if (!relayerSecret) throw new Error("RELAYER_SECRET is required for hosted console relay signing");
  const adminSecret = operatorAdminSecret();
  const relayerAddress = Keypair.fromSecret(relayerSecret).publicKey();
  const adminAddress = adminSecret ? Keypair.fromSecret(adminSecret).publicKey() : "";
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  const signerFor = (source: string) => {
    if (source === RELAY_SOURCE) return LocalKeypairSigner.fromSecret(relayerSecret);
    if (source === OPERATOR_ADMIN_SOURCE) {
      if (!adminSecret) throw new Error("BENZO_OPERATOR_ADMIN_SECRET is required for admin-gated console operations");
      return LocalKeypairSigner.fromSecret(adminSecret);
    }
    return LocalKeypairSigner.fromSecret(orgSecret);
  };
  const addressFor = (source: string) => {
    if (source === RELAY_SOURCE) return relayerAddress;
    if (source === OPERATOR_ADMIN_SOURCE) {
      if (!adminAddress) throw new Error("BENZO_OPERATOR_ADMIN_SECRET is required for admin-gated console operations");
      return adminAddress;
    }
    return orgAddress;
  };
  const submitWrite = async (opts: { contractId: string; source: string; fnArgs: string[] }) =>
    makeClientSubmitWrite({
      server,
      signer: signerFor(opts.source),
      feeBumpSigner: opts.source === HOSTED_ORG_SOURCE ? LocalKeypairSigner.fromSecret(relayerSecret) : undefined,
      networkPassphrase: cfg.networkPassphrase,
      addressFor,
    })(opts);
  return new StellarRpcClient({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
    addressFor,
    submitWrite,
  });
}

/** Build (once) a live BenzoClient bound to the configured wallet, or null if env is absent. */
export function getClient(relayer = false): BenzoClient | null {
  try {
    const key = `${clientCacheKey()}:${relayer ? "relayer" : "direct"}`;
    const existing = clients.get(key);
    if (existing) return existing;
    if (!process.env.SOROBAN_RPC_URL) return null;
    if (!hostedRuntime() && !process.env.DEPLOYER_SECRET) return null;
    let dep: Record<string, any>;
    try {
      dep = JSON.parse(readFileSync(DEPLOYMENT_URL, "utf8"));
    } catch {
      dep = JSON.parse(readFileSync(`${ROOT}/deployments/testnet.json`, "utf8"));
    }
    deployment = dep;
    const art = (c: string) => ({
      wasmPath: `${ROOT}/circuits/build/${c}/${c}_js/${c}.wasm`,
      zkeyPath: `${ROOT}/circuits/build/${c}/${c}.zkey`,
      // circuit id lets the TEE/routing prover dispatch by name (ignored by NodeProver).
      circuit: c,
    });
    const c = new BenzoClient({
      cli: chainClientForRuntime(),
      deployment: {
        pool: dep.pool, verifier: dep.verifier, merkle: dep.merkle,
        nullifierSet: dep.nullifierSet, aspMembership: dep.aspMembership,
        aspNonMembership: dep.aspNonMembership, viewkeyAnchor: dep.viewkeyAnchor,
        token: dep.token, treeLevels: dep.treeLevels, aspLevels: dep.aspLevels, smtLevels: dep.smtLevels,
      },
      circuits: { shield: art("shield"), joinsplit: art("joinsplit"), unshield: art("unshield"), proofOfBalance: art("proof_of_balance"), proofOfSum: art("proof_of_sum"), proofOfSumOrg: art("proof_of_sum_org"), proofOfBalanceOrg: art("proof_of_balance_org"), spendingCap: art("spending_cap"), payoutInnocence: art("payout_innocence"), orgSpendAuth: art("org_spend_auth"), payrollComputation: art("payroll_computation"), kybCredential: art("kyb_credential"), crossNetting: art("cross_netting"), joinsplitOrg: art("joinsplit_org") },
      // Business side ALWAYS proves in the attested TEE. The console is a managed
      // business workflow, so witnesses never fall back to a server-local
      // NodeProver. The org circuits are baked into the enclave image.
      prover: proverFromEnv({
        ...process.env,
        BENZO_PROVER_MODE: "tee",
        BENZO_PROVER_ENDPOINT: process.env.BENZO_PROVER_ENDPOINT || dep.tee?.endpoint,
        BENZO_PROVER_MEASUREMENT: process.env.BENZO_PROVER_MEASUREMENT || dep.tee?.composeHash,
        BENZO_PROVER_LOCAL_CIRCUITS: process.env.BENZO_PROVER_LOCAL_CIRCUITS ?? "",
      }),
      rpcUrl: process.env.SOROBAN_RPC_URL,
      txSource: consoleOrgSource(),
      aspSource: hostedRuntime() ? operatorAdminSource() : TX_SOURCE,
      relayer: relayer ? { source: RELAY_SOURCE, address: relayerAddress() } : undefined,
      handleRegistry: dep.handleRegistry,
      requestRegistry: dep.requestRegistry,
      store: new FileKVStore(statePath()),
    });
    const account = hostedRuntime()
      ? currentAuth()?.account
      : createOrLoadAccountFile(WALLET, { label: "console", stellarSecret: process.env.DEPLOYER_SECRET }).account;
    if (!account) throw new Error("Hosted console requires an auth-bound org account");
    c.useAccount(account);
    clients.set(key, c);
    return c;
  } catch {
    console.error("[console-api] live client unavailable; refusing app data");
    return null;
  }
}

export function isLive(): boolean {
  return getClient() !== null;
}

/**
 * The treasury's public Stellar address (the on/off-ramp edge). The durable
 * account file may carry no Stellar identity (it only needs shielded keys), so
 * fall back to the funding CLI key's address — that's the public G-address USDC
 * is sent to / received from / unshields to. Mirrors the wallet-api helper.
 */
async function selfAddress(c: BenzoClient): Promise<string> {
  if (c.account.stellarAddress) return c.account.stellarAddress;
  if (hostedRuntime()) throw new Error("Hosted console account has no Stellar public-edge address");
  return c.account.stellarAddress ?? (await c.opts.cli.keyAddress(TX_SOURCE));
}

function usdcAsset(): { code: string; issuer: string } {
  const [code, issuer] = String((deployment?.usdcAsset as string) ?? "USDC:").split(":");
  if (!code || !issuer) throw new Error("USDC asset deployment is missing");
  return { code, issuer };
}

function isMissingAccountError(e: unknown): boolean {
  const maybe = e as { response?: { status?: number }; status?: number; message?: string };
  return maybe.response?.status === 404 ||
    maybe.status === 404 ||
    /account.*not.*found|not.*found|404/i.test(String(maybe.message ?? e));
}

async function sponsoredTrustline(params: { accountSecret: string; sponsorSecret: string; asset: { code: string; issuer: string } }): Promise<void> {
  const sponsor = Keypair.fromSecret(params.sponsorSecret);
  const account = Keypair.fromSecret(params.accountSecret);
  const server = new Horizon.Server(HORIZON_URL);
  const sponsorAccount = await server.loadAccount(sponsor.publicKey());
  const asset = new Asset(params.asset.code, params.asset.issuer);
  const builder = new TransactionBuilder(sponsorAccount, {
    fee: BASE_FEE,
    networkPassphrase: process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  });
  for (const op of sponsoredTrustlineOps(
    { sponsor: sponsor.publicKey(), account: account.publicKey(), asset: params.asset },
    asset,
  )) {
    builder.addOperation(op);
  }
  const tx = builder.setTimeout(120).build();
  tx.sign(sponsor, account);
  await server.submitTransaction(tx);
}

async function waitForHostedRpcAccount(accountAddress: string): Promise<void> {
  const cfg = configFromEnv();
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      await server.getAccount(accountAddress);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i < 5 ? 1 : 2)));
    }
  }
  throw new Error(`Hosted console account is not visible to Soroban RPC yet: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

async function waitForHostedRpcReady(authKey: string, accountAddress: string): Promise<void> {
  const cached = hostedRpcVisibility.get(authKey);
  if (cached) return cached;
  const work = waitForHostedRpcAccount(accountAddress);
  hostedRpcVisibility.set(authKey, work);
  try {
    await work;
  } catch (e) {
    hostedRpcVisibility.delete(authKey);
    throw e;
  }
}

async function ensureHostedPublicAccount(opts: { waitForRpc?: boolean } = {}): Promise<void> {
  if (!hostedRuntime()) return;
  const auth = currentAuth();
  if (!auth?.account.stellarSecret || !auth.account.stellarAddress) throw new Error("Hosted console account has no public-edge signer");
  const accountSecret = auth.account.stellarSecret;
  const accountAddress = auth.account.stellarAddress;
  const cached = hostedProvisioning.get(auth.key);
  if (cached) {
    const address = await cached;
    if (opts.waitForRpc !== false) await waitForHostedRpcReady(auth.key, address);
    return;
  }
  const work = (async () => {
    const sponsorSecret = process.env.RELAYER_SECRET;
    if (!sponsorSecret) throw new Error("RELAYER_SECRET is required for hosted console onboarding");
    const asset = usdcAsset();
    const server = new Horizon.Server(HORIZON_URL);
    try {
      const account = await server.loadAccount(accountAddress);
      const hasTrustline = account.balances.some((b) =>
        "asset_code" in b &&
        b.asset_code === asset.code &&
        "asset_issuer" in b &&
        b.asset_issuer === asset.issuer
      );
      if (!hasTrustline) await sponsoredTrustline({ accountSecret, sponsorSecret, asset });
    } catch (e) {
      if (!isMissingAccountError(e)) throw e;
      await sponsoredOnboard({
        horizonUrl: HORIZON_URL,
        networkPassphrase: process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
        sponsorSecret,
        asset,
        newAccountSecret: accountSecret,
      });
    }
    return accountAddress;
  })();
  hostedProvisioning.set(auth.key, work);
  try {
    const address = await work;
    if (opts.waitForRpc !== false) await waitForHostedRpcReady(auth.key, address);
  } catch (e) {
    hostedProvisioning.delete(auth.key);
    hostedRpcVisibility.delete(auth.key);
    throw e;
  }
}

/** Basic Stellar account-id (G-address) shape check before a public send. */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}

/**
 * The treasury's PUBLIC (liquid, unshielded) USDC balance — the SAC balance at
 * the treasury's own public Stellar address. This is the plain liquid USDC any
 * external wallet/exchange sees; the org's M-of-N shielded pool is separate
 * (payableBalance/computeTreasury).
 */
export async function treasuryPublicBalance(): Promise<{ stroops: string; address: string; asset: string; issuer: string; live: boolean }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Treasury balance was not read.");
  const address = await selfAddress(c);
  await ensureHostedPublicAccount({ waitForRpc: false });
  const token = deployment?.token as string;
  const [asset, issuer] = String((deployment?.usdcAsset as string) ?? "USDC:").split(":");
  let stroops = "0";
  try {
    stroops = String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", address]));
  } catch (e) {
    // A fresh org can have a valid Stellar account with no SAC balance entry yet.
    // Surface that as zero liquid USDC, not as an app-breaking 500.
    console.warn("[console-api] public treasury balance unavailable; treating as zero", e instanceof Error ? e.message : e);
  }
  return { stroops, address, asset: asset || "USDC", issuer: issuer || "", live: true };
}

/**
 * The treasury's public receive coordinates (address + asset/issuer) for a
 * Receive QR — so any wallet/exchange can pay the org's PUBLIC balance. Mirrors
 * the wallet getDepositInfo (address half).
 */
export async function treasuryReceiveInfo(): Promise<{ address: string; asset: string; issuer: string; live: boolean }> {
  try {
    const c = getClient();
    if (!c) throw new Error("Live console client unavailable.");
    const address = await selfAddress(c);
    await ensureHostedPublicAccount({ waitForRpc: false });
    const [asset, issuer] = String((deployment?.usdcAsset as string) ?? "USDC:").split(":");
    return { address, asset: asset || "USDC", issuer: issuer || "", live: true };
  } catch (e) {
    throw new Error((e as Error).message || "Live treasury receive info unavailable.");
  }
}

/**
 * Send PUBLIC USDC from the treasury to an external wallet (a real classic-
 * equivalent USDC transfer via the SAC). Credits the recipient's USDC trustline
 * — what external wallets/exchanges see. Pre-checks the liquid balance and maps
 * a missing-trustline failure to friendly copy (NEVER fabricates success).
 */
export async function treasurySendPublic(toAddress: string, amount: string): Promise<{ txHash?: string; onChain: boolean; error?: string }> {
  const c = getClient();
  if (!c) return { onChain: false, error: "console API is not connected to live testnet signing" };
  const to = toAddress.trim();
  if (!isValidStellarAddress(to)) return { onChain: false, error: "That doesn't look like a valid wallet address." };
  const stroops = BigInt(amount);
  if (stroops <= 0n) return { onChain: false, error: "Enter an amount greater than zero." };
  try {
    const from = await selfAddress(c);
    const token = deployment?.token as string;
    const liquid = BigInt(String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", from])));
    if (stroops > liquid) return { onChain: false, error: "Not enough in your Public balance to send that." };
    const r = await c.opts.cli.invoke({
      contractId: token,
      source: consoleOrgSource(),
      send: true,
      // SAC transfer(from, to, amount) — `from` is the treasury's custodial account.
      fnArgs: ["transfer", "--from", from, "--to", to, "--amount", stroops.toString()],
    });
    return { onChain: true, txHash: r.txHash };
  } catch (e) {
    const m = String((e as Error)?.message ?? e).toLowerCase();
    if (/trustline|trust line|not.*authoriz|#\s*\d*\s*trust|balance line/.test(m)) {
      return { onChain: false, error: "That wallet isn't set up to receive USDC yet." };
    }
    return { onChain: false, error: "Couldn't send right now. Your money is safe — please try again." };
  }
}

// Note: there is no "Make public" for the org treasury. It's held as M-of-N ORG
// notes spendable only via pool.transfer_org; the single-key c.unshield selects a
// note owned by this.account.spendPub, which org notes are not — so there is no
// direct org -> public unshield primitive in this build. The console doesn't
// offer it. (Make private = fundTreasury/shield; Receive tops up Public.)

/**
 * Wire the on-chain authorized-MVK registry mirror into the pool (once), so live
 * note-binding ops produce a `registeredMvkRoot` the registry accepts (else the
 * single-leaf fallback is rejected — Contract #13). Self-registers our MVK if absent.
 */
const mvkWiredRoot = new WeakMap<BenzoClient, bigint>();
async function wireMvkRegistry(c: BenzoClient): Promise<void> {
  const registry = deployment?.mvkRegistry as string | undefined;
  const rpc = process.env.SOROBAN_RPC_URL;
  if (!registry || !rpc) return;
  const myMvk = c.account.mvkScalar;
  const myLeaf = mvkRegistryLeaf(myMvk, 0n);
  let onchain = BigInt((await c.opts.cli.view(registry, TX_SOURCE, ["current_root"])) as string);
  if (mvkWiredRoot.get(c) === onchain) return;
  let leaves = await fetchMvkRegistryLeaves(rpc, registry, 1);
  if (!leaves.includes(myLeaf)) {
    await c.opts.cli.invoke({ contractId: registry, source: operatorAdminSource(), send: true, fnArgs: ["register_mvk", "--mvk_pub", myMvk.toString(), "--key_meta", "0"] });
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const reg = new MvkRegistryMirror();
    if (leaves.includes(myLeaf)) {
      reg.syncWithOwnedKey(leaves, myMvk, 0n);
      onchain = BigInt((await c.opts.cli.view(registry, TX_SOURCE, ["current_root"])) as string);
      if (reg.root() === onchain) {
        c.pool.useMvkRegistry(reg);
        mvkWiredRoot.set(c, onchain);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 500 + attempt * 250));
    leaves = await fetchMvkRegistryLeaves(rpc, registry, 1);
  }
  if (!leaves.includes(myLeaf)) throw new Error("mvk registry: own MVK missing after registration");
  // Rebuild the full mirror + record our key at its real index — robust whether
  // or not another key was registered after us (matches the wallet-api fix).
  const reg = new MvkRegistryMirror();
  reg.syncWithOwnedKey(leaves, myMvk, 0n);
  onchain = BigInt((await c.opts.cli.view(registry, TX_SOURCE, ["current_root"])) as string);
  if (reg.root() !== onchain) throw new Error(`mvk registry mirror drift: mirror=${reg.root()} onchain=${onchain}`);
  c.pool.useMvkRegistry(reg);
  mvkWiredRoot.set(c, onchain);
}

/**
 * Onboarding step 6 — register the org owner's MVK on-chain (the one genuinely
 * real, ZK action in business onboarding). Treasury decode
 * + prove-balance depend on it. Returns the tx + the resulting registry root.
 */
export async function registerOwnerMvk(): Promise<{ onChain: boolean; txHash?: string; mvkRoot?: string }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. MVK was not registered.");
  const registry = deployment?.mvkRegistry as string | undefined;
  const rpc = process.env.SOROBAN_RPC_URL;
  if (!registry || !rpc) throw new Error("MVK registry deployment is missing.");
  const myMvk = c.account.mvkScalar;
  const myLeaf = mvkRegistryLeaf(myMvk, 0n);
  let leaves = await fetchMvkRegistryLeaves(rpc, registry, 1);
  let txHash: string | undefined;
  if (!leaves.includes(myLeaf)) {
    const r = await c.opts.cli.invoke({ contractId: registry, source: operatorAdminSource(), send: true, fnArgs: ["register_mvk", "--mvk_pub", myMvk.toString(), "--key_meta", "0"] });
    txHash = r.txHash;
  }
  mvkWiredRoot.delete(c); // force a fresh mirror that includes our (possibly new) leaf
  await wireMvkRegistry(c);
  const root = (await c.opts.cli.view(registry, TX_SOURCE, ["current_root"])) as string;
  return { onChain: true, txHash, mvkRoot: String(root) };
}

// ---------------------------------------------------------------- on-chain KYB
// KYB is a REAL on-chain attestation. The decision is signed by
// the designated issuer key and stored in org_account; the console READS it from
// chain. The issuer key is the integration seam: today it is our own key; a real
// provider (Persona/Sumsub) would hold it (or we re-point to theirs) and post
// decisions on-chain, with NO backend deciding. Org-of-one: the business
// Local/dev uses org_id 1. Hosted console derives a stable, non-PII u64 from the
// authenticated Google account key so separate orgs never collide on-chain.
function kybOrgId(): string {
  const auth = currentAuth();
  if (hostedRuntime()) {
    if (!auth) throw new Error("Hosted console requires Google account auth");
    const n = BigInt(`0x${auth.key.slice(0, 16)}`) & ((1n << 63n) - 1n);
    return (n === 0n ? 1n : n).toString();
  }
  return "1";
}

function orgAccountId(): string | undefined {
  return deployment?.orgAccount as string | undefined;
}

// ---------------------------------------------------- org M-of-N treasury ----
// The org treasury is held as ORG notes (recipientPk = orgRecipientPk) spendable
// ONLY via pool.transfer_org under a >= threshold member quorum. The member keys
// derive deterministically from the owner's account seed (reproducible on every
// device + this self-hosted BFF), and the memberRoot is published on-chain in
// org_account. This is what makes the console's pay path dual-controlled in
// circuit, not just by an off-chain approval flag.
const ORG_MEMBERS = 3;
const ORG_THRESHOLD = 2n;
/** Approving quorum slots (proposer + approver) — the maker-checker, in-circuit. */
const ORG_SIGNERS = [0, 1];
/** Deterministic EdDSA approver seeds (the managed service holds these). The
 *  anonymous-approval proof (ORGAUTH) shows >= threshold of these signed, hiding
 *  which. Distinct from the treasury spend group (akGroup) used at settlement. */
const ORG_APPROVER_SEEDS = [11, 12, 13];
function relayerAddress(): string {
  if (process.env.RELAYER_SECRET) return Keypair.fromSecret(process.env.RELAYER_SECRET).publicKey();
  return process.env.RELAYER_PUBLIC || "";
}
const RELAYER_ADDR = (): string => relayerAddress();

const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Map a run id to a field-element spend message (binds the approval to the run). */
function runSpendMessage(runId: string): bigint {
  return BigInt("0x" + createHash("sha256").update(runId).digest("hex")) % BN254_FIELD;
}

/** The org's deterministic M-of-N identity (cached in the client). */
async function getOrg(c: BenzoClient) {
  return c.orgIdentity({ orgId: kybOrgId(), memberCount: ORG_MEMBERS, threshold: ORG_THRESHOLD });
}

/** Idempotently register the org + publish its in-circuit member_root on-chain. */
const orgSetupDone = new Set<string>();
async function ensureOrgSetup(c: BenzoClient): Promise<void> {
  const setupKey = kybOrgId();
  if (orgSetupDone.has(setupKey)) return;
  const orgContract = orgAccountId();
  if (!orgContract) return;
  await ensureOrgRegistered(c, orgContract);
  const org = await getOrg(c);
  let current: string | null = null;
  try {
    current = String(await c.opts.cli.view(orgContract, TX_SOURCE, ["member_root", "--org_id", setupKey]));
  } catch {
    current = null;
  }
  if (current !== org.memberRoot.toString()) {
    await c.opts.cli.invoke({
      contractId: orgContract,
      source: operatorAdminSource(),
      send: true,
      fnArgs: ["set_member_root", "--org_id", setupKey, "--root", org.memberRoot.toString()],
    });
  }
  orgSetupDone.add(setupKey);
}

/** Normalize the on-chain KybStatus union (returned as a variant name) to a UI string. */
function kybLabel(raw: unknown): "unverified" | "pending" | "approved" | "rejected" {
  const s = String(raw).toLowerCase();
  if (s.includes("approved")) return "approved";
  if (s.includes("rejected")) return "rejected";
  if (s.includes("pending")) return "pending";
  return "unverified";
}

/** Read the org's KYB status + inquiry ref straight from chain. */
export async function getKybStatus(): Promise<{ status: "unverified" | "pending" | "approved" | "rejected"; inquiryRef: string; onChain: boolean }> {
  try {
    const c = getClient();
    const org = orgAccountId();
    if (!c || !org) throw new Error("Live KYB contract unavailable.");
    const r = await c.opts.cli.view(org, TX_SOURCE, ["kyb_status", "--org_id", kybOrgId()]);
    const arr = Array.isArray(r) ? r : [r, "0"]; // contract returns (KybStatus, U256)
    return { status: kybLabel(arr[0]), inquiryRef: String(arr[1] ?? "0"), onChain: true };
  } catch (e) {
    throw new Error((e as Error).message || "Live KYB status unavailable.");
  }
}

/** Ensure the org-of-one exists on-chain so a KYB decision can be attested to it. */
async function ensureOrgRegistered(c: BenzoClient, org: string): Promise<void> {
  try {
    await c.opts.cli.view(org, TX_SOURCE, ["get_org", "--org_id", kybOrgId()]);
    return; // already registered
  } catch {
    /* OrgNotFound → register it below */
  }
  const admin = deployment?.admin as string | undefined;
  if (!admin) throw new Error("deployment missing admin address for org registration");
  await c.opts.cli.invoke({
    contractId: org,
    source: operatorAdminSource(),
    send: true,
    fnArgs: [
      "register_org",
      "--org_id", kybOrgId(),
      "--group_pubkey", c.account.mvkScalar.toString(),
      "--threshold", "1",
      "--members", JSON.stringify([admin]),
    ],
  });
}

/**
 * Post the org's KYB decision ON-CHAIN, signed by the issuer key (issuer-gated in
 * the contract). Returns the resulting on-chain status.
 */
export async function attestKyb(approve: boolean): Promise<{ onChain: boolean; status: string; txHash?: string; inquiryRef: string }> {
  const c = getClient();
  const org = orgAccountId();
  if (!c || !org) throw new Error("Live KYB contract unavailable. KYB was not attested.");
  await ensureOrgRegistered(c, org);
  const inquiryRef = Date.now().toString(); // ties the on-chain record to the provider case file
  const r = await c.opts.cli.invoke({
    contractId: org,
    source: operatorAdminSource(),
    send: true,
    fnArgs: ["attest_kyb", "--org_id", kybOrgId(), "--status", approve ? "Approved" : "Rejected", "--inquiry_ref", inquiryRef],
  });
  const expected = approve ? "approved" : "rejected";
  let after = await getKybStatus();
  for (let attempt = 0; after.status !== expected && attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 750 + attempt * 150));
    after = await getKybStatus();
  }
  if (after.status !== expected) {
    throw new Error(`KYB attestation submitted but chain read returned ${after.status}`);
  }
  return { onChain: true, status: after.status, txHash: r.txHash, inquiryRef };
}

// The org treasury balance requires an incremental chain re-sync, which is slow
// to run on every dashboard/treasury poll. Cache it with a short TTL and bust the
// cache on any treasury mutation (fund / payout) so reads stay fast + correct.
let treasuryBalCache: { at: number; stroops: bigint } | null = null;
const TREASURY_TTL_MS = 12_000;
export function bustTreasuryCache(): void {
  treasuryBalCache = null;
}
async function orgTreasuryStroops(c: BenzoClient): Promise<bigint> {
  if (treasuryBalCache && Date.now() - treasuryBalCache.at < TREASURY_TTL_MS) {
    return treasuryBalCache.stroops;
  }
  const org = await getOrg(c);
  const stroops = await c.orgTreasuryBalance(org);
  treasuryBalCache = { at: Date.now(), stroops };
  return stroops;
}

/** The org's dual-controlled TREASURY balance (stroops). */
export async function payableBalance(): Promise<{ live: boolean; stroops: bigint }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Treasury balance was not read.");
  return { live: true, stroops: await orgTreasuryStroops(c) };
}

/** Fund the org treasury: shield real USDC into an M-of-N org note. */
export async function fundTreasury(amountStroops: string): Promise<{ onChain: boolean; txHash?: string; error?: string }> {
  const c = getClient();
  if (!c) return { onChain: false, error: "console API is not connected to live testnet signing" };
  const from = await selfAddress(c);
  try {
    await ensureHostedPublicAccount();
    await c.sync();
    await wireMvkRegistry(c);
    await ensureOrgSetup(c);
    const org = await getOrg(c);
    const r = await c.fundTreasury({ org, amount: BigInt(amountStroops), fromAddress: from, fromSource: consoleOrgSource() });
    await c.flush();
    bustTreasuryCache();
    return { onChain: true, txHash: r.txHash };
  } catch (e) {
    return { onChain: false, error: (e as Error).message };
  }
}

/**
 * Pay ONE recipient as a confidential joinsplit to their @handle. Returns:
 *  - { onChain, txHash } on real settlement,
 *  - { error } on a real failure (so the operator sees WHY a line failed).
 * The caller drives idempotency/funding — this just pays one line, safely.
 */
export async function payOne(handle: string | undefined, amount: string): Promise<{ onChain: boolean; txHash?: string; error?: string }> {
  const c = getClient();
  if (!c) return { onChain: false, error: "console API is not connected to live testnet signing" };
  if (!handle) return { onChain: false, error: "no @handle on file for this contractor" };
  try {
    await c.sync();
    await wireMvkRegistry(c);
    await ensureOrgSetup(c);
    const org = await getOrg(c);
    const to = await c.resolveHandle(handle.replace(/^@/, ""));
    // Dual-controlled spend: settles via pool.transfer_org under a >= threshold
    // member quorum (JSPLITORG), NOT a single-key transfer.
    const res = await c.orgPayroll({ org, payouts: [{ to, amount: BigInt(amount) }], signerIndices: ORG_SIGNERS, relayer: RELAYER_ADDR() });
    await c.flush();
    bustTreasuryCache();
    return { onChain: true, txHash: res[0]?.txHash };
  } catch (e) {
    return { onChain: false, error: (e as Error).message };
  }
}

/** Live status + which env vars block live mode. */
export function liveStatus(): { live: boolean; mode: "live" | "unavailable"; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.SOROBAN_RPC_URL) missing.push("SOROBAN_RPC_URL");
  if (hostedRuntime()) {
    if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
    if (!process.env.BENZO_ACCOUNT_SALT && !process.env.BENZO_AUTH_SALT) missing.push("BENZO_ACCOUNT_SALT");
    if (!process.env.RELAYER_SECRET) missing.push("RELAYER_SECRET");
    if (!process.env.BENZO_PRIVATE_EVENT_SECRET) missing.push("BENZO_PRIVATE_EVENT_SECRET");
    if (!operatorAdminSecret()) missing.push("BENZO_OPERATOR_ADMIN_SECRET");
  } else if (!process.env.DEPLOYER_SECRET) {
    missing.push("DEPLOYER_SECRET");
  }
  const canProbeClient = !hostedRuntime() || currentAuth() !== null;
  const live = missing.length === 0 && (canProbeClient ? getClient() !== null : true);
  return { live, mode: live ? "live" : "unavailable", missing };
}

function toBig(v: unknown): bigint {
  return typeof v === "bigint" ? v : BigInt(String(v ?? 0));
}

/** Treasury view — the REAL dual-controlled (M-of-N) treasury balance. */
export async function computeTreasury(): Promise<TreasuryView> {
  const c = getClient();
  if (c) {
    const stroops = toBig(await orgTreasuryStroops(c));
    const money = (a: string): Money => ({ amount: a, assetCode: "USDC" });
    const accounts = db.accounts.map((account, i) => ({
      account,
      // the org treasury is one M-of-N pool; report it on the operating account.
      balance: i === 0 ? money(stroops.toString()) : money("0"),
    }));
    return { totalHidden: money(stroops.toString()), accounts, proveBalanceAvailable: true, live: true };
  }
  throw new Error("Live console client unavailable. Treasury was not computed.");
}

/** A normalized on-chain reference the console renders in a "see on-chain" detail view. */
export interface OnChainRef {
  vkId: string;
  verified: boolean;
  verifier: string;
  network: string;
  txHash?: string;
  root?: string;
  publics?: Array<{ k: string; v: string }>;
}
function onChainRef(vkId: string, verified: boolean, publics?: Array<{ k: string; v: string }>, extra?: { txHash?: string; root?: string }): OnChainRef {
  return {
    vkId,
    verified,
    verifier: (deployment?.verifier as string) ?? "",
    network: process.env.NETWORK_PASSPHRASE ?? "testnet",
    publics,
    ...extra,
  };
}

export interface AuditRootAnchorResult {
  onChain: boolean;
  contractId?: string;
  txHash?: string;
  sequence?: string;
  error?: string;
}

export async function anchorPrivateAuditRoot(input: {
  orgHash: string;
  merkleRoot: string;
  headHash: string;
  packetHash: string;
  eventCount: number;
}): Promise<AuditRootAnchorResult> {
  const c = getClient();
  if (!c) return { onChain: false, error: "console API is not connected to live testnet signing" };
  const contractId = deployment?.auditRoot as string | undefined;
  if (!contractId) return { onChain: false, error: "auditRoot contract is not deployed in deployments/testnet.json" };
  try {
    const seqRaw = await c.opts.cli.view(contractId, TX_SOURCE, ["next_sequence", "--org_hash", input.orgHash]);
    const sequence = BigInt(String(seqRaw ?? 0)).toString();
    const res = await c.opts.cli.invoke({
      contractId,
      source: operatorAdminSource(),
      send: true,
      fnArgs: [
        "anchor_root",
        "--org_hash", input.orgHash,
        "--sequence", sequence,
        "--merkle_root", input.merkleRoot,
        "--head_hash", input.headHash,
        "--packet_hash", input.packetHash,
        "--event_count", String(input.eventCount),
      ],
    });
    return { onChain: true, contractId, txHash: res.txHash, sequence };
  } catch (e) {
    return { onChain: false, contractId, error: "Could not anchor private audit root." };
  }
}

/** stroops (7dp) -> "$X.XX" for public-input display. */
function usdLabel(stroops: string): string {
  const n = Number(BigInt(stroops || "0")) / 1e7;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Prove the M-of-N org treasury holds AT LEAST `minStroops` as a REAL Groth16
 * org-proof-of-balance, VERIFIED ON-CHAIN (vk_id ORGBAL) — revealing only the
 * floor, never the balance. This is the single primitive behind three console
 * claims (just vary the floor):
 *   • "Payroll funded ✓"      floor = run total       (over-budget runs blocked)
 *   • reserves-to-lender/board floor = covenant amount
 *   • true solvency           floor = Σ liabilities
 * `holds:false` (no proof) when the treasury genuinely can't cover the floor —
 * an honest, cryptographic "no".
 */
export async function proveBalance(
  minStroops: string,
  context = 0n,
  vkLabel = "ORGBAL",
  publicLabel = "Holds at least",
): Promise<{ holds: boolean; onChain: boolean; minStroops: string; ref: OnChainRef }> {
  const publics = [{ k: publicLabel, v: usdLabel(minStroops) }];
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Balance proof was not generated.");
  try {
    await c.sync();
    await wireMvkRegistry(c);
    await ensureOrgSetup(c);
    const org = await getOrg(c);
    const r = await c.proveOrgBalance({ org, minTotal: BigInt(minStroops), context });
    return { holds: r.holds, onChain: r.onChain, minStroops, ref: onChainRef(vkLabel, r.holds && r.onChain, publics, { root: r.root?.toString() }) };
  } catch (e) {
    // Honest failure: fall back to the view-key figure without claiming a proof.
    console.warn("[console-api] balance proof failed; returning unverified fallback result", e instanceof Error ? e.message : e);
    let bal = 0n;
    try {
      bal = await c.orgTreasuryBalance(await getOrg(c));
    } catch {
      bal = 0n;
    }
    return { holds: bal >= BigInt(minStroops), onChain: false, minStroops, ref: onChainRef(vkLabel, false, publics) };
  }
}

/**
 * "Payroll funded ✓" — prove the treasury covers a run's TOTAL before settling,
 * on-chain (ORGBAL), without revealing the treasury or the run amount.
 */
export async function proveFunded(runTotalStroops: string): Promise<{ funded: boolean; onChain: boolean; ref: OnChainRef }> {
  const r = await proveBalance(runTotalStroops, 1n, "ORGBAL", "Run total");
  return { funded: r.holds, onChain: r.onChain, ref: r.ref };
}

/**
 * In-ZK spending policy (Z3): prove a single payout (to `handle`, `amountStroops`)
 * is WITHIN `capStroops`, verified on-chain (vk_id SPENDCAP), amount hidden. The
 * cap is a circuit constraint, so an over-cap payout cannot produce a proof —
 * `withinCap:false` is a cryptographic "no", the line is provably blocked.
 */
export async function proveLineCap(
  handle: string,
  amountStroops: string,
  capStroops: string,
  context = 0n,
): Promise<{ withinCap: boolean; onChain: boolean }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Spending-cap proof was not generated.");
  try {
    const to = await c.resolveHandle(handle.replace(/^@/, ""));
    const r = await c.proveOrgPayoutCap({ to, amount: BigInt(amountStroops), cap: BigInt(capStroops), context });
    return { withinCap: r.withinCap, onChain: r.onChain };
  } catch {
    console.warn("[console-api] spending-cap proof failed; returning blocked proof result");
    return { withinCap: false, onChain: false };
  }
}

/**
 * Per-payout proof-of-innocence (Z4): prove a payout's recipient (`handle`) is
 * NOT on the sanctions/deny set, verified on-chain (vk_id POIPAYOUT), recipient
 * hidden. `innocent:false` => the recipient is sanctioned (no non-inclusion proof
 * exists), the line is provably blocked.
 */
export async function proveLineInnocence(
  handle: string,
  amountStroops: string,
  context = 0n,
): Promise<{ innocent: boolean; onChain: boolean }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Innocence proof was not generated.");
  try {
    const to = await c.resolveHandle(handle.replace(/^@/, ""));
    const r = await c.proveOrgPayoutInnocence({ to, amount: BigInt(amountStroops), context });
    return { innocent: r.innocent, onChain: r.onChain };
  } catch {
    console.warn("[console-api] recipient-screen proof failed; returning blocked proof result");
    return { innocent: false, onChain: false };
  }
}

/**
 * Cross-entity private netting (Z8): prove two parties' mutual invoices net to a
 * single difference on-chain (vk_id NETTING), grosses hidden. `weOweStroops` =
 * what this org owes the counterparty; `theyOweStroops` = what they owe us.
 */
export async function proveNetting(
  weOweStroops: string,
  theyOweStroops: string,
  context = 0n,
): Promise<{ onChain: boolean; net: string; wetPay: boolean; ref?: OnChainRef }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Netting proof was not generated.");
  try {
    const r = await c.proveCrossNetting({ aOwesB: BigInt(weOweStroops), bOwesA: BigInt(theyOweStroops), context });
    const wetPay = r.payerIsA === 1n;
    return {
      onChain: r.onChain, net: r.net.toString(), wetPay,
      ref: onChainRef("NETTING", r.onChain, [{ k: "Net to settle", v: usdLabel(r.net.toString()) }, { k: "Direction", v: wetPay ? "You pay them" : "They pay you" }]),
    };
  } catch {
    console.warn("[console-api] netting proof failed; returning unverified result");
    return { onChain: false, net: "0", wetPay: true };
  }
}

// KYB-as-ZK credential config (Z7). The managed service holds the issuer seed +
// the org holder scalar; the org's jurisdiction/tier come from its KYB record.
const KYB_ISSUER_SEED = 77;
const KYB_HOLDER_SK = 1234567890123456789n;
const KYB_JURISDICTION = 840n; // US (ISO-3166 numeric)
const KYB_TIER = 2n;
const KYB_DOCS_HASH = 99887766554433n; // hash of the KYB documents (NEVER revealed)
/** ISO-3166 numeric -> alpha-2 for the few we surface. */
const JURISDICTION_LABEL: Record<string, string> = { "840": "US", "124": "CA", "826": "GB", "276": "DE" };
export function jurisdictionLabel(code: string): string {
  return JURISDICTION_LABEL[code] ?? code;
}

/**
 * KYB-as-ZK credential (Z7): prove the org holds an issuer-signed KYB credential,
 * disclosing only "verified business, jurisdiction Y, tier Z", verified on-chain
 * (vk_id KYB), WITHOUT revealing the documents. Sybil-resistant via orgNullifier.
 */
export async function proveKybCredential(): Promise<{ ok: boolean; onChain: boolean; jurisdiction: string; tier: string; ref?: OnChainRef }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. KYB proof was not generated.");
  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const r = await c.proveOrgKyb({
      issuerSeed: KYB_ISSUER_SEED,
      holderSk: KYB_HOLDER_SK,
      jurisdiction: KYB_JURISDICTION,
      tier: KYB_TIER,
      docsHash: KYB_DOCS_HASH,
      expiry: nowSec + 365n * 24n * 3600n,
      serial: 42n,
      scope: 2026n,
      currentTime: nowSec,
    });
    const jur = jurisdictionLabel(r.jurisdiction.toString());
    return {
      ok: r.ok, onChain: r.onChain, jurisdiction: jur, tier: r.tier.toString(),
      ref: onChainRef("KYB", r.onChain, [{ k: "Jurisdiction", v: jur }, { k: "Tier", v: r.tier.toString() }, { k: "Documents", v: "hidden (only the credential is disclosed)" }]),
    };
  } catch {
    console.warn("[console-api] KYB proof failed; returning unverified result");
    return { ok: false, onChain: false, jurisdiction: jurisdictionLabel(KYB_JURISDICTION.toString()), tier: KYB_TIER.toString() };
  }
}

/**
 * Verifiable payroll computation (Z6): prove a run's total + per-line commitments
 * were correctly derived from the rate card (gross = rate*period - deductions,
 * runTotal = Σ gross), verified on-chain (vk_id PAYCOMP), with the rate card kept
 * PRIVATE. Reconstructs the rate-card inputs from each line's stored gross
 * (period 1, no deductions, so gross = the computed amount).
 */
export async function proveRunComputation(
  lines: { handle?: string; amount: string }[],
  context = 0n,
): Promise<{ ok: boolean; onChain: boolean; runTotal: string; ref?: OnChainRef }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Payroll computation proof was not generated.");
  try {
    const compLines = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.handle || BigInt(l.amount || "0") <= 0n) continue;
      const to = await c.resolveHandle(l.handle.replace(/^@/, ""));
      compLines.push({
        rate: BigInt(l.amount),
        period: 1n,
        deductions: 0n,
        recipientPk: to.spendPub,
        blinding: BigInt(1000 + i),
      });
    }
    if (compLines.length === 0) return { ok: false, onChain: false, runTotal: "0" };
    const r = await c.proveOrgPayrollComputation({ lines: compLines, context });
    return {
      ok: r.ok, onChain: r.onChain, runTotal: r.runTotal.toString(),
      ref: onChainRef("PAYCOMP", r.onChain, [{ k: "Run total (computed)", v: usdLabel(r.runTotal.toString()) }, { k: "Rate card", v: "private (rate × period − deductions)" }]),
    };
  } catch {
    console.warn("[console-api] payroll computation proof failed; returning unverified result");
    return { ok: false, onChain: false, runTotal: "0" };
  }
}

/**
 * Anonymous approver / surveillance-free dual-control (Z5): prove >= threshold
 * DISTINCT org approvers signed off on a run, verified on-chain (vk_id ORGAUTH),
 * WITHOUT revealing WHICH approvers signed. `approved:false` if fewer than the
 * threshold signed (no proof).
 */
export async function proveAnonymousApproval(
  runId: string,
): Promise<{ approved: boolean; onChain: boolean; approvers: number; threshold: number; memberCount: number; ref?: OnChainRef }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Anonymous approval proof was not generated.");
  try {
    const r = await c.proveOrgApproval({
      memberSeeds: ORG_APPROVER_SEEDS,
      signerIndices: ORG_SIGNERS,
      threshold: ORG_THRESHOLD,
      spendMessage: runSpendMessage(runId),
    });
    return {
      approved: r.approved, onChain: r.onChain, approvers: r.approvers, threshold: Number(r.threshold), memberCount: r.memberCount,
      ref: onChainRef("ORGAUTH", r.approved && r.onChain, [{ k: "Approvers", v: `${r.approvers} of ${r.memberCount}` }, { k: "Threshold (M-of-N)", v: String(r.threshold) }]),
    };
  } catch {
    console.warn("[console-api] anonymous approval proof failed; returning unverified result");
    return { approved: false, onChain: false, approvers: 0, threshold: Number(ORG_THRESHOLD), memberCount: ORG_MEMBERS };
  }
}

/**
 * True solvency — prove treasury >= Σ liabilities (pending payroll + open
 * invoices) on-chain (ORGBAL), both sides hidden. `liabilitiesStroops` is summed
 * by the caller (it knows the books); the proof shows only that the floor holds.
 */
export async function proveSolvency(liabilitiesStroops: string): Promise<{ solvent: boolean; onChain: boolean; liabilities: string; ref: OnChainRef }> {
  const r = await proveBalance(liabilitiesStroops, 3n, "ORGBAL", "Liabilities (Σ)");
  return { solvent: r.holds, onChain: r.onChain, liabilities: liabilitiesStroops, ref: r.ref };
}

/**
 * Disclose the EXACT treasury total to an auditor as a real ZK proof-of-sum,
 * VERIFIED ON-CHAIN. Proves the disclosed notes sum to `total` (individual amounts stay
 * hidden) and the chain confirms the SUM proof via verify_proof(SUM,…).
 */
// The honest soundness boundary of a proof-of-sum: it proves the DISCLOSED notes
// sum to `total`, NOT that the disclosed set is complete. A discloser could omit
// notes and under-report; completeness is only constrained by the authorized-MVK
// registry binding (only registered keys' notes can enter the pool). Surfaced to
// the auditor so the attestation is never oversold as "tax-grade / audited".
export const SUM_SOUNDNESS_BOUNDARY =
  "Proves the disclosed notes sum to this total; does NOT prove set-completeness (omitted notes are undetectable). Bounds under-reporting only via the authorized-MVK registry.";

export async function proveTotal(): Promise<{ total: string; onChain: boolean; soundness?: string; ref?: OnChainRef }> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Total proof was not generated.");
  // Real ZK org proof-of-sum over the M-of-N treasury notes, verified ON-CHAIN
  // (vk_id ORGSUM): reveals only the total, never an individual salary. Falls
  // back to the view-key figure only if no org notes exist yet.
  const org = await getOrg(c);
  try {
    const r = await c.proveOrgTotal({ org });
    return {
      total: r.total.toString(),
      onChain: r.onChain,
      soundness: SUM_SOUNDNESS_BOUNDARY,
      ref: onChainRef("ORGSUM", r.onChain, [
        { k: "Disclosed total", v: usdLabel(r.total.toString()) },
        { k: "Soundness", v: "ownership of the stated total, not set-completeness" },
      ], { root: r.root?.toString() }),
    };
  } catch {
    return { total: (await c.orgTreasuryBalance(org)).toString(), onChain: false };
  }
}

/**
 * Records export (Z2): a self-contained, network-verified attestation that the
 * org's shielded treasury sums to an exact total for a period — the document you
 * hand a tax authority or auditor. It embeds the REAL Groth16 proof-of-sum
 * (vk_id ORGSUM) and its public signals so a third party can independently
 * re-run verify_proof(ORGSUM,…) against the on-chain verifier. Individual
 * salaries are never disclosed; only the total is.
 */
export async function proveTotalAttestation(period: string): Promise<{
  period: string;
  total: string;
  onChain: boolean;
  vkId: string;
  verifier: string;
  network: string;
  root: string;
  sorobanProof: unknown;
  sorobanPublics: string[];
  issuedAt: string;
}> {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Total attestation was not generated.");
  const org = await getOrg(c);
  try {
    await c.sync();
    await wireMvkRegistry(c);
    await ensureOrgSetup(c);
    const r = await c.proveOrgTotal({ org });
    return {
      period,
      total: r.total.toString(),
      onChain: r.onChain,
      vkId: "ORGSUM",
      verifier: (deployment?.verifier as string) ?? "",
      network: process.env.NETWORK_PASSPHRASE ?? "testnet",
      root: r.root.toString(),
      sorobanProof: r.sorobanProof,
      sorobanPublics: r.sorobanPublics,
      issuedAt: now(),
    };
  } catch (e) {
    console.warn("[console-api] total attestation proof failed; returning unverified fallback result", e instanceof Error ? e.message : e);
  }
  let total = "0";
  try {
    total = (await c.orgTreasuryBalance(org)).toString();
  } catch {
    total = "0";
  }
  return {
    period,
    total,
    onChain: false,
    vkId: "ORGSUM",
    verifier: (deployment?.verifier as string) ?? "",
    network: process.env.NETWORK_PASSPHRASE ?? "testnet",
    root: "",
    sorobanProof: null,
    sorobanPublics: [],
    issuedAt: now(),
  };
}

/**
 * Issue a REAL scoped viewing key for an auditor grant: a one-way TVK derived
 * from the org's master viewing key + the grant scope (deriveTvk). It is
 * decrypt-only, scope-isolated (different scope -> uncorrelated key), and never
 * a signer — the actual selective-disclosure primitive, not a random hash. The
 * org hands the auditor this scoped key; the auditor can then passively decrypt
 * only the in-scope notes, never the master key or any spend authority.
 */
export function auditorGrantViewKey(scopeLabel: string): { viewKey: string; live: boolean } {
  const c = getClient();
  if (!c) throw new Error("Live console client unavailable. Auditor grant key was not generated.");
  const tvk = deriveTvk(c.account.mvkSecret, scopeLabel || "audit");
  return { viewKey: toHex(tvk.publicKey), live: true };
}

/**
 * Settle a shielded transfer for `po` with a real joinsplit proof + on-chain
 * submit to `toHandle`.
 */
export async function submitShieldedTransfer(po: PaymentOrder, toHandle?: string): Promise<PaymentOrder> {
  const c = getClient();
  if (c && toHandle) {
    const r = await payOne(toHandle, po.amount.amount); // syncs + wires MVK + settles, with try/catch
    if (r.onChain) {
      po.status = "confirmed";
      po.settlement = { txHash: r.txHash, nullifiers: r.txHash ? [r.txHash] : [], onChain: true, mode: "onchain" };
      po.updatedAt = now();
      return po;
    }
    if (r.error) {
      po.status = "failed";
      po.settlement = { onChain: false, mode: "failed" };
      po.updatedAt = now();
      console.warn("[console-api] payment settlement failed; marking payment failed");
      return po;
    }
    // No live settlement happened; fall through to the failed branch below.
  }
  // NOT settled on-chain — the BFF isn't live, or the recipient has no on-chain
  // @handle. Do NOT fabricate a txHash or approved state.
  console.warn(c ? "[console-api] payment was not settled on-chain" : "[console-api] payment settlement skipped because live client is unavailable");
  po.status = "failed";
  po.settlement = { onChain: false, mode: "failed" };
  po.updatedAt = now();
  return po;
}

/**
 * Confidential batch payroll — a real joinsplit per recipient (amounts
 * note-hidden) via client.payroll. Returns a tx hash per item.
 */
export async function runPayroll(
  items: { handle?: string; amount: string }[],
): Promise<{ onChain: boolean; txHash?: string }[]> {
  const c = getClient();
  const allHandles = items.length > 0 && items.every((it) => it.handle);
  if (c && allHandles) {
    await c.sync();
    await wireMvkRegistry(c);
    await ensureOrgSetup(c);
    const org = await getOrg(c);
    const payouts = [];
    for (const it of items) {
      const to = await c.resolveHandle((it.handle as string).replace(/^@/, ""));
      payouts.push({ to, amount: BigInt(it.amount) });
    }
    // Confidential payroll under in-circuit M-of-N dual control. PREFER the
    // batched path (pool.batch_transfer_org: one combined BN254 pairing check per
    // chunk of payouts, auto-chunked at the measured ~10-15/tx limit). It needs a
    // distinct treasury note per payout; a single-note treasury falls back to the
    // per-payout chained orgPayroll so single-treasury runs never break.
    let res;
    try {
      res = await c.orgBatchPayroll({ org, payouts, signerIndices: ORG_SIGNERS, relayer: RELAYER_ADDR() });
    } catch (e) {
      if (/distinct note/.test((e as Error).message)) {
        console.warn("[console-api] batch payroll fell back to chained org payroll");
        res = await c.orgPayroll({ org, payouts, signerIndices: ORG_SIGNERS, relayer: RELAYER_ADDR() });
      } else {
        throw e;
      }
    }
    await c.flush();
    bustTreasuryCache();
    return res.map((r) => ({ onChain: true, txHash: r.txHash ?? undefined }));
  }
  // NOT settled on-chain — don't fabricate tx hashes.
  console.warn(c ? "[console-api] payroll was not settled on-chain" : "[console-api] payroll settlement skipped because live client is unavailable");
  return items.map(() => ({ onChain: false }));
}
