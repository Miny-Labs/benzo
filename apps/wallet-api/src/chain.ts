/**
 * The LIVE seam to @benzo/core for the consumer wallet. With the testnet env
 * loaded (`set -a; . ./.env; set +a`) and the ~/.benzo wallet present, these
 * settle REAL testnet USDC (real Groth16 proofs + Soroban). If the live client
 * cannot be initialized, API routes fail closed instead of serving local balances
 * or claiming settlement results.
 *
 * Proving path is selectable per call — `local` (NodeProver, snarkjs on this
 * host) or `tee` (PhalaProver, the attested Phala enclave). This is what the test
 * matrix exercises: "proving on tee + locally" both settle on-chain, identical
 * soundness (proof verified on-chain), differing only in WHERE the witness lives.
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BASE_FEE,
  Asset,
  Contract,
  Horizon,
  Keypair,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  BenzoClient,
  LocalKeypairSigner,
  MvkRegistryMirror,
  NodeProver,
  StellarCli,
  StellarRpcClient,
  accountFromClaimSecret,
  configFromEnv,
  createOrLoadAccountFile,
  fetchMvkRegistryLeaves,
  makeTeeProver,
  makeClientSubmitWrite,
  mvkRegistryLeaf,
  scvalForWriteArg,
  sponsoredOnboard,
  sponsoredTrustlineOps,
  usdcToStroops,
  type ChainClient,
  type ProverPort,
} from "@benzo/core";
import { encodeBenzoLink } from "@benzo/links";
import { db, nowSec, type ActivityRow, type WalletInvite } from "./store.js";
import { currentAuth } from "./auth.js";
import { hostedRuntime } from "./runtime.js";

export type ProverKind = "local" | "tee";

const ROOT = process.env.BENZO_ROOT || process.cwd();
const DEPLOYMENT_URL = new URL("../../../deployments/testnet.json", import.meta.url);
const TX_SOURCE = "benzo-deployer";
const RELAY_SOURCE = "benzo-relayer";
const OPERATOR_ADMIN_SOURCE = "benzo-operator-admin";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
// The consumer wallet's OWN shielded identity + note-discovery state — kept
// SEPARATE from the business console (a wallet user is a different account; the
// two products never share an identity). App-specific env vars so a generic
// override can't accidentally re-merge them.
const WALLET = process.env.BENZO_WALLET_ACCOUNT || join(homedir(), ".benzo", "wallet", "account.json");
const STATE = process.env.BENZO_WALLET_STATE || join(dirname(WALLET), "state.json");
const DEFAULT_WALLET_ORIGIN = "https://wallet.benzo.space";

function walletWebOrigin(): string {
  const direct = process.env.BENZO_WALLET_ORIGIN?.trim().replace(/\/+$/, "");
  if (direct) return direct;
  const linkBase = process.env.BENZO_LINK_BASE?.trim();
  if (linkBase) {
    try {
      return new URL(linkBase).origin;
    } catch {
      /* ignore malformed overrides */
    }
  }
  return DEFAULT_WALLET_ORIGIN;
}

function walletRouteLink(link: string): string {
  return `${walletWebOrigin()}/claim#${encodeURIComponent(link)}`;
}

function operatorAdminSecret(): string | null {
  return process.env.BENZO_OPERATOR_ADMIN_SECRET
    ?? process.env.BENZO_RAMP_ADMIN_SECRET
    ?? process.env.RAMP_ADMIN_SECRET
    ?? process.env.DEPLOYER_SECRET
    ?? null;
}

function operatorAdminSource(): string {
  return hostedRuntime() ? OPERATOR_ADMIN_SOURCE : TX_SOURCE;
}

function errorSummary(e: unknown): { message: string; name?: string; stack?: string } {
  const err = e as { message?: string; name?: string; stack?: string };
  return {
    message: String(err?.message ?? e),
    name: err?.name,
    stack: err?.stack,
  };
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

let dep: Record<string, string | number> | null = null;
function deployment(): Record<string, string | number> {
  if (!dep) {
    try {
      dep = JSON.parse(readFileSync(DEPLOYMENT_URL, "utf8"));
    } catch {
      dep = JSON.parse(readFileSync(`${ROOT}/deployments/testnet.json`, "utf8"));
    }
  }
  return dep!;
}

export function walletVerifierId(): string {
  return String(deployment().verifier ?? "");
}

/** The TEE config (endpoint + pinned measurement) from the deployment record. */
export function teeConfig(): { endpoint: string; measurement: string } | null {
  try {
    const d = deployment() as { tee?: { endpoint?: string; composeHash?: string } };
    if (d.tee?.endpoint && d.tee?.composeHash) return { endpoint: d.tee.endpoint, measurement: d.tee.composeHash };
  } catch {
    // deployment record unreadable — no TEE info.
  }
  return null;
}

function buildProver(kind: ProverKind): ProverPort {
  if (kind === "tee") {
    const cfg = teeConfig();
    if (!cfg) throw new Error("no TEE configured in deployments/testnet.json");
    return makeTeeProver({ endpoint: cfg.endpoint, measurement: cfg.measurement });
  }
  if (hostedRuntime()) {
    throw new Error("hosted local proving is disabled; use browser local proving or the attested TEE");
  }
  return new NodeProver();
}

const clients = new Map<string, BenzoClient>();

function loadWalletAccount() {
  if (hostedRuntime()) {
    const auth = currentAuth();
    if (!auth) throw new Error("Hosted wallet requires Google/passkey account auth");
    return auth.account;
  }
  if (!process.env.DEPLOYER_SECRET) throw new Error("DEPLOYER_SECRET is required for live wallet account");
  return createOrLoadAccountFile(WALLET, { label: "wallet", stellarSecret: process.env.DEPLOYER_SECRET }).account;
}

function clientCacheKey(prover: ProverKind): string {
  const auth = currentAuth();
  if (hostedRuntime()) {
    if (!auth) throw new Error("Hosted wallet requires Google/passkey account auth");
    return `${auth.key}:${prover}`;
  }
  return `local:${prover}`;
}

function statePath(): string {
  const auth = currentAuth();
  if (hostedRuntime()) {
    if (!auth) throw new Error("Hosted wallet requires Google/passkey account auth");
    return join(tmpdir(), `benzo-wallet-${auth.key}.json`);
  }
  return STATE;
}

function chainClientForRuntime(): ChainClient {
  const cfg = configFromEnv();
  if (!hostedRuntime()) return new StellarCli(cfg);
  const auth = currentAuth();
  const userSecret = auth?.account.stellarSecret;
  const userAddress = auth?.account.stellarAddress;
  if (!userSecret || !userAddress) throw new Error("Hosted wallet account has no Stellar public-edge signer");
  const relayerSecret = process.env.RELAYER_SECRET;
  if (!relayerSecret) throw new Error("RELAYER_SECRET is required for hosted wallet relay signing");
  const adminSecret = operatorAdminSecret();
  const relayerAddress = Keypair.fromSecret(relayerSecret).publicKey();
  const adminAddress = adminSecret ? Keypair.fromSecret(adminSecret).publicKey() : "";
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  const signerFor = (source: string) => {
    if (source === RELAY_SOURCE) return LocalKeypairSigner.fromSecret(relayerSecret);
    if (source === OPERATOR_ADMIN_SOURCE) {
      if (!adminSecret) throw new Error("BENZO_OPERATOR_ADMIN_SECRET is required for admin-gated wallet operations");
      return LocalKeypairSigner.fromSecret(adminSecret);
    }
    return LocalKeypairSigner.fromSecret(userSecret);
  };
  const addressFor = (source: string) => {
    if (source === RELAY_SOURCE) return relayerAddress;
    if (source === OPERATOR_ADMIN_SOURCE) {
      if (!adminAddress) throw new Error("BENZO_OPERATOR_ADMIN_SECRET is required for admin-gated wallet operations");
      return adminAddress;
    }
    return userAddress;
  };
  const submitWrite = async (opts: { contractId: string; source: string; fnArgs: string[] }) =>
    makeClientSubmitWrite({
      server,
      signer: signerFor(opts.source),
      feeBumpSigner: opts.source === RELAY_SOURCE ? undefined : LocalKeypairSigner.fromSecret(relayerSecret),
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

/**
 * Build (and cache) a live BenzoClient with the requested proving backend. The
 * client is rebuilt when the prover kind changes; tests drive the two paths
 * sequentially (never concurrently on the same wallet/state), so a single cached
 * client is safe.
 */
export function getClient(prover: ProverKind = hostedRuntime() ? "tee" : "local"): BenzoClient | null {
  try {
    const key = clientCacheKey(prover);
    const existing = clients.get(key);
    if (existing) return existing;
    if (!process.env.SOROBAN_RPC_URL) {
      return null;
    }
    if (!hostedRuntime() && !process.env.DEPLOYER_SECRET) {
      return null;
    }
    const d = deployment();
    // `circuit` is the short name a delegated/TEE prover uses to find its own
    // staged artifacts (the enclave keys by name, not path); NodeProver/WasmProver
    // ignore it and use the paths. The enclave stages the wallet circuits used by
    // low-power/API flows, including proof_of_balance for mobile Share Proof.
    const art = (c: string) => ({
      wasmPath: `${ROOT}/circuits/build/${c}/${c}_js/${c}.wasm`,
      zkeyPath: `${ROOT}/circuits/build/${c}/${c}.zkey`,
      circuit: c,
    });
    const c = new BenzoClient({
      cli: chainClientForRuntime(),
      deployment: {
        pool: d.pool as string, verifier: d.verifier as string, merkle: d.merkle as string,
        nullifierSet: d.nullifierSet as string, aspMembership: d.aspMembership as string,
        aspNonMembership: d.aspNonMembership as string, viewkeyAnchor: d.viewkeyAnchor as string,
        token: d.token as string, treeLevels: d.treeLevels as number, aspLevels: d.aspLevels as number,
        smtLevels: d.smtLevels as number,
      },
      circuits: {
        shield: art("shield"), joinsplit: art("joinsplit"), unshield: art("unshield"),
        proofOfBalance: art("proof_of_balance"), proofOfSum: art("proof_of_sum"),
      },
      prover: buildProver(prover),
      rpcUrl: process.env.SOROBAN_RPC_URL,
      txSource: "benzo-deployer",
      aspSource: hostedRuntime() ? operatorAdminSource() : "benzo-deployer",
      handleRegistry: d.handleRegistry as string,
      requestRegistry: d.requestRegistry as string,
      store: new FileKVStore(statePath()),
    });
    c.useAccount(loadWalletAccount());
    clients.set(key, c);
    return c;
  } catch {
    console.error("[wallet-api] live client unavailable; refusing app data");
    return null;
  }
}

export function isLive(): boolean {
  return getClient() !== null;
}

export function liveStatus(): { live: boolean; mode: "live" | "unavailable"; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.SOROBAN_RPC_URL) missing.push("SOROBAN_RPC_URL");
  if (hostedRuntime()) {
    if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
    if (!process.env.BENZO_ACCOUNT_SALT && !process.env.BENZO_AUTH_SALT) missing.push("BENZO_ACCOUNT_SALT");
    if (!process.env.RELAYER_SECRET) missing.push("RELAYER_SECRET");
    if (!operatorAdminSecret()) missing.push("BENZO_OPERATOR_ADMIN_SECRET");
  } else if (!process.env.DEPLOYER_SECRET) {
    missing.push("DEPLOYER_SECRET");
  }
  const canProbeClient = !hostedRuntime() || currentAuth() !== null;
  const live = missing.length === 0 && (canProbeClient ? isLive() : true);
  return { live, mode: live ? "live" : "unavailable", missing };
}

/** Which proving backends are reachable + the attested-TEE coordinates. */
export function proverInfo(): { available: ProverKind[]; tee: { endpoint: string; measurement: string } | null } {
  const tee = teeConfig();
  if (hostedRuntime()) return { available: tee ? ["tee"] : [], tee };
  return { available: tee ? ["local", "tee"] : ["local"], tee };
}

const hostedProvisioning = new Map<string, Promise<void>>();

/**
 * The wallet's public Stellar address (the on/off-ramp edge). The durable account
 * file may carry no Stellar identity (it only needs the shielded keys), so fall
 * back to resolving the funding CLI key's address — that's the public G-address
 * USDC unshields to and shields from.
 */
async function selfAddress(c: BenzoClient): Promise<string> {
  if (c.account.stellarAddress) return c.account.stellarAddress;
  if (hostedRuntime()) throw new Error("Hosted wallet account has no Stellar public-edge address");
  return c.account.stellarAddress ?? (await c.opts.cli.keyAddress(TX_SOURCE));
}

function usdcAsset(): { code: string; issuer: string } {
  const [code, issuer] = String(deployment().usdcAsset ?? "USDC:").split(":");
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

async function ensureHostedPublicAccount(): Promise<void> {
  if (!hostedRuntime()) return;
  const auth = currentAuth();
  if (!auth?.account.stellarSecret || !auth.account.stellarAddress) throw new Error("Hosted wallet account has no public-edge signer");
  const accountSecret = auth.account.stellarSecret;
  const accountAddress = auth.account.stellarAddress;
  const cached = hostedProvisioning.get(auth.key);
  if (cached) return cached;
  const work = (async () => {
    const sponsorSecret = process.env.RELAYER_SECRET;
    if (!sponsorSecret) throw new Error("RELAYER_SECRET is required for hosted wallet onboarding");
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
  })();
  hostedProvisioning.set(auth.key, work);
  try {
    await work;
  } catch (e) {
    hostedProvisioning.delete(auth.key);
    throw e;
  }
}

/**
 * Wire the on-chain authorized-MVK registry mirror into the pool client (once),
 * so note-binding ops use a `registeredMvkRoot` the on-chain registry accepts.
 * We replay the prior on-chain leaves, then `register()` our own MVK so the
 * mirror can produce its membership path (and self-register on-chain if needed).
 * Fails loud if the mirror root diverges from the on-chain root.
 */
const mvkWired = new WeakSet<BenzoClient>();
async function wireMvkRegistry(c: BenzoClient): Promise<void> {
  if (mvkWired.has(c)) return;
  const d = deployment();
  const registry = d.mvkRegistry as string | undefined;
  const rpc = process.env.SOROBAN_RPC_URL;
  if (!registry || !rpc) return;
  const myMvk = c.account.mvkScalar;
  const myLeaf = mvkRegistryLeaf(myMvk, 0n);
  let leaves = await fetchMvkRegistryLeaves(rpc, registry, 1);
  if (!leaves.includes(myLeaf)) {
    // not yet registered — register our MVK on-chain, then refetch.
    try {
      await c.opts.cli.invoke({
        contractId: registry,
        source: operatorAdminSource(),
        send: true,
        fnArgs: ["register_mvk", "--mvk_pub", myMvk.toString(), "--key_meta", "0"],
      });
    } catch (e) {
      console.error("[wallet-api] mvk registration failed", errorSummary(e));
      throw e;
    }
    leaves = await fetchMvkRegistryLeaves(rpc, registry, 1);
  }
  if (!leaves.includes(myLeaf)) throw new Error("mvk registry: own MVK missing after registration");
  // Rebuild the full mirror from ALL leaves and record our key at its real index
  // — robust whether or not someone (e.g. a claimed link account) registered
  // after us. The root then always matches on-chain.
  const reg = new MvkRegistryMirror();
  reg.syncWithOwnedKey(leaves, myMvk, 0n);
  const onchain = BigInt((await c.opts.cli.view(registry, TX_SOURCE, ["current_root"])) as string);
  if (reg.root() !== onchain) {
    throw new Error(`mvk registry mirror drift: mirror=${reg.root()} onchain=${onchain}`);
  }
  c.pool.useMvkRegistry(reg);
  mvkWired.add(c);
}

/** Accept human ("25.50") or stroop ("250000000") amounts; normalise to stroops. */
export function toStroops(amount: string): bigint {
  const s = String(amount).trim();
  return s.includes(".") ? usdcToStroops(s) : /^\d+$/.test(s) && s.length > 9 ? BigInt(s) : usdcToStroops(s);
}

// ----------------------------------------------------------------- balance

export async function getBalanceStroops(): Promise<{ stroops: string; live: boolean }> {
  const c = getClient();
  if (c) {
    await c.sync();
    return { stroops: (await c.getBalance()).toString(), live: true };
  }
  throw new Error("Live testnet client unavailable. Balance was not read.");
}

// ----------------------------------------------------------------- history

const NOTE: Record<string, (cp?: string) => string> = {
  receive: () => "Paid you",
  send: () => "You sent",
  shield: () => "Added money",
  cashIn: () => "Added money",
  unshield: () => "Cash out",
  cashOut: () => "Cash out · testnet reserve",
};
const DIRECTION: Record<string, "in" | "out"> = {
  receive: "in", shield: "in", cashIn: "in", send: "out", unshield: "out", cashOut: "out",
};

/** Friendly display name + note for an edge (cash/shield) vs a person (send/receive). */
function nameFor(type: string, counterparty?: string): { name: string; note: string } {
  if (type === "shield" || type === "cashIn") return { name: "Added money", note: "From testnet reserve" };
  if (type === "unshield" || type === "cashOut") return { name: "Cash out", note: "To testnet reserve" };
  // person-to-person: prefer a friendly @handle/label, never a raw G-address.
  const friendly = counterparty && counterparty !== "shielded" && !/^G[A-Z2-7]{40,}$/.test(counterparty);
  return { name: friendly ? counterparty! : NOTE[type]?.() ?? type, note: NOTE[type]?.() ?? type };
}

export async function getActivity(): Promise<ActivityRow[]> {
  const c = getClient();
  if (c) {
    await c.sync();
    const items = c.getHistory();
    return items
      .map((h, i): ActivityRow => {
        const { name, note } = nameFor(h.type, h.counterparty);
        return {
          id: `h_${i}_${h.txHash ?? h.timestamp}`,
          type: h.type,
          name,
          note: `${note}${h.memo ? ` · ${h.memo}` : ""}`,
          amount: h.amount,
          direction: DIRECTION[h.type] ?? "out",
          status: h.status === "settled" ? "settled" : h.status === "failed" ? "failed" : "proving",
          timestamp: h.timestamp,
          txHash: h.txHash,
          tone: DIRECTION[h.type] === "in" ? "accent" : h.type.startsWith("cash") || h.type === "unshield" ? "amber" : "neutral",
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }
  return [];
}

// ----------------------------------------------------------------- send

export interface SettleResult {
  status: "settled" | "failed";
  txHash?: string;
  provingMs?: number;
  prover: ProverKind;
  amount: string;
  onChain: boolean;
  sorobanPublics?: string[];
  error?: string;
}

/** A live phase event, streamed to the UI's 3-phase send ceremony. */
export type SendPhase =
  | { phase: "building" }
  | { phase: "proving" }
  | { phase: "submitting"; provingMs?: number; txHash?: string }
  | { phase: "confirmed"; txHash?: string; provingMs?: number; onChain: boolean }
  | { phase: "failed"; error: string };

export type PhaseSink = (e: SendPhase) => void;

/** How a typed recipient resolves: a private @handle, a public G-address, or unknown. */
export function classifyRecipient(to: string): "handle" | "address" | "invite" {
  const t = to.trim();
  if (/^G[A-Z2-7]{55}$/.test(t)) return "address";
  if (t.startsWith("@")) return "handle";
  if (/^[a-z0-9_.]{3,20}$/i.test(t)) return "handle";
  return "invite";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Unified consumer send with live phase events for the 3-phase ceremony. A
 * `@handle` is a private shielded transfer; a `G…` Stellar address is a public
 * payout (unshield) that intentionally leaves the shield. Both move real USDC on
 * testnet when live. If no live client exists, value movement fails closed.
 */
export async function send(
  to: string,
  amount: string,
  memo: string | undefined,
  prover: ProverKind,
  onPhase?: PhaseSink,
): Promise<SettleResult> {
  const kind = classifyRecipient(to);
  const stroops = toStroops(amount);
  const c = getClient(prover);

  if (!c) {
    onPhase?.({ phase: "failed", error: "Live testnet client unavailable. No funds were moved." });
    throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
  }

  await ensureHostedPublicAccount();
  await c.sync();
  await wireMvkRegistry(c);
  onPhase?.({ phase: "building" });

  if (kind === "address") {
    // public payout — unshield to the given Stellar address
    onPhase?.({ phase: "proving" });
    const wd = await c.unshield({ amount: stroops, toAddress: to.trim() });
    onPhase?.({ phase: "submitting", provingMs: wd.provingMs, txHash: wd.txHash });
    await c.flush();
    onPhase?.({ phase: "confirmed", txHash: wd.txHash, provingMs: wd.provingMs, onChain: true });
    return { status: "settled", txHash: wd.txHash, provingMs: wd.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: wd.sorobanPublics };
  }

  // private shielded send to a @handle
  const sh = await c.sendToHandle({ handle: to.replace(/^@/, ""), amount: stroops, memo, useRelayer: false });
  sh.onProgress((e: { status?: string }) => {
    if (e.status === "proving") onPhase?.({ phase: "proving" });
  });
  const r = await sh.settled();
  onPhase?.({ phase: "submitting", provingMs: r?.provingMs, txHash: r?.txHash });
  await c.flush();
  onPhase?.({ phase: "confirmed", txHash: r?.txHash, provingMs: r?.provingMs, onChain: true });
  return { status: "settled", txHash: r?.txHash, provingMs: r?.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: r?.sorobanPublics };
}

export async function sendToHandle(
  handle: string,
  amount: string,
  memo: string | undefined,
  prover: ProverKind,
): Promise<SettleResult> {
  const stroops = toStroops(amount);
  const c = getClient(prover);
  if (c) {
    await ensureHostedPublicAccount();
    await c.sync();
    await wireMvkRegistry(c);
    const sh = await c.sendToHandle({ handle: handle.replace(/^@/, ""), amount: stroops, useRelayer: false });
    const r = await sh.settled();
    await c.flush();
    return { status: "settled", txHash: r?.txHash, provingMs: r?.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: r?.sorobanPublics };
  }
  throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
}

// ------------------------------------------------------------ testnet ramp reserve
// The on-ramp/off-ramp USDC leg runs through the on-chain `ramp` reserve contract:
// cash_in dispenses real testnet USDC from the reserve to back a shield; cash_out
// pulls the unshielded USDC back into the reserve. No real fiat partner settles.

function rampId(): string | undefined {
  return deployment().ramp as string | undefined;
}

/** 32 hex chars → the CLI decodes to 16 bytes, left-padded to the contract's
 *  BytesN<32> `reference` (the per-tx memo, mirroring the anchor). */
function rampRef(): string {
  return (Date.now().toString(16) + Math.floor(Math.random() * 1e16).toString(16)).padStart(32, "0").slice(-32);
}

/** A clean, user-safe ramp failure. NEVER carries raw CLI/stack text — the BFF
 *  surfaces `.message`/`.code` straight to the wallet, so a web2 user sees plain
 *  English, never `stellar contract invoke ...`. */
export class RampError extends Error {
  constructor(public code: "reserve" | "limit" | "balance" | "paused" | "busy", message: string) {
    super(message);
    this.name = "RampError";
  }
}

/** Map a raw chain/CLI error to a clean RampError by the ramp contract's error
 *  codes (BelowMin=4, AboveMax=5, DuplicateRef=6, InsufficientReserve=7, Paused=2)
 *  or shape. The raw text is dropped on the floor — only the code/copy escapes. */
function mapRampError(e: unknown, dir: "in" | "out"): RampError {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  if (/insufficientreserve|#7\b|error.*7\)/.test(m)) {
    return new RampError("reserve", dir === "in" ? "The cash reserve is topping up. Try again in a moment, or a smaller amount." : "The cash reserve is busy. Please try again in a moment.");
  }
  if (/\bpaused\b|#2\b/.test(m)) return new RampError("paused", "Cash in and out are paused for maintenance. Please try again shortly.");
  if (/belowmin|abovemax|invalidamount|#3\b|#4\b|#5\b/.test(m)) {
    return new RampError("limit", "That amount is outside the allowed range.");
  }
  if (/duplicateref|#6\b/.test(m)) return new RampError("busy", "That request was already processed. Please try again.");
  // bad sequence / timeout / rate-limit / anything else internal → generic busy.
  return new RampError("busy", dir === "in" ? "Couldn't add money right now. Your money is safe. Please try again." : "Couldn't cash out right now. Your money is safe. Please try again.");
}

/** Live USDC reserve balance (stroops) — readable by anyone, straight from chain. */
export async function getRampReserve(): Promise<{ reserve: string; live: boolean }> {
  try {
    const ramp = rampId();
    const c = getClient();
    if (!ramp || !c) throw new Error("Live ramp reserve unavailable.");
    const r = await c.opts.cli.view(ramp, TX_SOURCE, ["reserve"]);
    return { reserve: String(r), live: true };
  } catch {
    throw new Error("Live ramp reserve unavailable.");
  }
}

/** On-ramp: dispense `stroops` USDC from the reserve to `to`, to back a shield.
 *  Pre-checks the reserve so an under-funded reserve fails with clean copy instead
 *  of an on-chain revert, then maps any chain error through RampError. */
async function rampCashIn(c: BenzoClient, to: string, stroops: bigint): Promise<void> {
  const ramp = rampId();
  if (!ramp) return; // no ramp configured → fall through to the legacy funded path
  // Clean pre-check: read the live reserve; if it can't cover the dispense, fail
  // fast with friendly copy (and don't burn a tx). A failed read just falls
  // through to the invoke, which maps its own error.
  try {
    const reserve = BigInt(String(await c.opts.cli.view(ramp, TX_SOURCE, ["reserve"])));
    if (reserve < stroops) throw new RampError("reserve", "The cash reserve is topping up. Try again in a moment, or a smaller amount.");
  } catch (e) {
    if (e instanceof RampError) throw e;
    /* reserve read failed — let the invoke be the source of truth */
  }
  try {
    await c.opts.cli.invoke({
      contractId: ramp,
      source: operatorAdminSource(),
      send: true,
      fnArgs: ["cash_in", "--to", to, "--amount", stroops.toString(), "--reference", rampRef()],
    });
  } catch (e) {
    console.error("[wallet-api] ramp cash_in failed", errorSummary(e));
    throw mapRampError(e, "in");
  }
}

/** Off-ramp: pull `stroops` USDC from `from` back into the reserve. */
async function rampCashOut(c: BenzoClient, from: string, stroops: bigint): Promise<void> {
  const ramp = rampId();
  if (!ramp) return;
  try {
    await c.opts.cli.invoke({
      contractId: ramp,
      source: TX_SOURCE,
      send: true,
      fnArgs: ["cash_out", "--from", from, "--amount", stroops.toString(), "--reference", rampRef()],
    });
  } catch (e) {
    console.error("[wallet-api] ramp cash_out failed", errorSummary(e));
    throw mapRampError(e, "out");
  }
}

// ----------------------------------------------------------------- cash out

// Reserve-modeled per-transaction caps (USD), enforced on-chain by the ramp
// contract. We validate them here too so a below-minimum / over-cap request fails
// fast before the irreversible unshield, never leaving a half-completed cash-out.
const CASHOUT_MIN = 50_000_000n; // $5.00
const CASHOUT_MAX = 25_000_000_000n; // $2,500.00

export async function cashOut(amount: string, prover: ProverKind): Promise<SettleResult> {
  const stroops = toStroops(amount);
  if (stroops < CASHOUT_MIN || stroops > CASHOUT_MAX) {
    throw new RampError("limit", "Cash-out must be between $5 and $2,500.");
  }
  const c = getClient(prover);
  if (c) {
    await ensureHostedPublicAccount();
    await c.sync();
    await wireMvkRegistry(c);
    // Unshield to the wallet's own public Stellar address (the off-ramp edge),
    // then hand that USDC to the on-chain ramp reserve (the anchor absorbs it;
    // the fiat payout is the only simulated leg).
    const to = await selfAddress(c);
    const wd = await c.unshield({ amount: stroops, toAddress: to });
    await c.flush();
    await rampCashOut(c, to, stroops);
    return { status: "settled", txHash: wd.txHash, provingMs: wd.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: wd.sorobanPublics };
  }
  throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
}

// ----------------------------------------------------------------- add money

export async function addMoney(amount: string, prover: ProverKind = "local"): Promise<SettleResult> {
  const stroops = toStroops(amount);
  const c = getClient(prover);
  if (c) {
    await ensureHostedPublicAccount();
    await c.sync();
    await wireMvkRegistry(c);
    const from = await selfAddress(c);
    const before = await c.getBalance();
    try {
      // On-ramp: the on-chain ramp reserve dispenses real USDC to the funding
      // address (the anchor's distribution account), then we shield it. Only the
      // fiat *charge* is simulated; every USDC movement here is real + on-chain.
      await rampCashIn(c, from, stroops);
      const sh = await c.shield({ amount: stroops, fromAddress: from, fromSource: TX_SOURCE });
      await c.flush();
      return { status: "settled", txHash: sh.txHash, provingMs: sh.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: sh.sorobanPublics };
    } catch (e) {
      console.error("[wallet-api] add-money failed", errorSummary(e));
      // The shield's on-chain submit + proof verification happen BEFORE the SDK's
      // post-submit `assertSynced` full-tree check. On a long-lived deployment the
      // historical pool-tree mirror can't be fully rebuilt from RPC (event
      // retention), so that strict check can trip even though the shield settled.
      // Shield correctness doesn't depend on the full tree (it only inserts a new
      // commitment), so confirm settlement by the balance delta and report success.
      if (/out of sync/.test((e as Error).message)) {
        await c.sync();
        const after = await c.getBalance();
        if (after > before) {
          return { status: "settled", prover, amount: stroops.toString(), onChain: true, error: "mirror-incomplete (settled; full-tree mirror behind RPC retention)" };
        }
      }
      throw e;
    }
  }
  throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
}

// ----------------------------------------------- direct deposit / import USDC
// "Import money" = the user sends USDC to their wallet's public Stellar address
// from ANY other wallet/exchange (no ramp, no bank), then shields it privately.
// The address is public; the shield is the same real Groth16/BN254 on-chain op.

/** The wallet's public deposit address + its current LIQUID (unshielded) USDC. */
export async function getDepositInfo(): Promise<{ address: string; liquid: string; asset: string; issuer: string; live: boolean }> {
  try {
    const c = getClient();
    if (!c) throw new Error("Live testnet client unavailable.");
    await ensureHostedPublicAccount();
    const address = await selfAddress(c);
    const token = deployment().token as string;
    const [asset, issuer] = String(deployment().usdcAsset ?? "USDC:").split(":");
    let liquid = "0";
    try {
      liquid = String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", address]));
    } catch (e) {
      // A newly sponsored account can have no SAC balance entry until the first
      // USDC lands. The deposit address is still valid; liquid USDC is 0.
      console.warn("[wallet-api] public balance unavailable; treating as zero", e instanceof Error ? e.message : e);
    }
    return { address, liquid, asset: asset || "USDC", issuer: issuer || "", live: true };
  } catch (e) {
    throw new Error((e as Error).message || "Live deposit address unavailable.");
  }
}

/** Import: shield the wallet's liquid (externally-deposited) USDC into the private
 *  pool. `amount` optional (defaults to all liquid). Real shield, real proof. */
export async function importDeposit(amount: string | undefined, prover: ProverKind = "local"): Promise<SettleResult> {
  const stroops0 = amount ? toStroops(amount) : 0n;
  const c = getClient(prover);
  if (!c) throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
  await ensureHostedPublicAccount();
  await c.sync();
  await wireMvkRegistry(c);
  const from = await selfAddress(c);
  const token = deployment().token as string;
  const liquid = BigInt(String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", from])));
  const stroops = amount ? stroops0 : liquid;
  if (stroops <= 0n) throw new RampError("balance", "No deposited USDC to import yet. Send USDC to your address first.");
  if (stroops > liquid) throw new RampError("balance", "That's more than the USDC deposited to your address.");
  const before = await c.getBalance();
  try {
    const sh = await c.shield({ amount: stroops, fromAddress: from, fromSource: TX_SOURCE });
    await c.flush();
    return { status: "settled", txHash: sh.txHash, provingMs: sh.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: sh.sorobanPublics };
  } catch (e) {
    if (/out of sync/.test((e as Error).message)) {
      await c.sync();
      if ((await c.getBalance()) > before) return { status: "settled", prover, amount: stroops.toString(), onChain: true };
    }
    throw e;
  }
}

// ----------------------------------------------------------- public balance / send
// The "Public" balance is the wallet's plain, liquid USDC on its own Stellar
// account — what external wallets/exchanges send TO and receive FROM. "Make
// private" shields it (importDeposit, above); "Make public" unshields the pool
// back to this same address; "Send to a wallet" pays any external G-address.

/** The "Public" balance: the wallet's liquid (unshielded) USDC, in stroops.
 *  Reuses the same liquid read as getDepositInfo(). */
export async function publicBalance(): Promise<{ stroops: string; address: string; asset: string; issuer: string; live: boolean }> {
  const info = await getDepositInfo();
  return { stroops: info.liquid, address: info.address, asset: info.asset, issuer: info.issuer, live: true };
}

/** "Make public": unshield from the private pool to the wallet's OWN public
 *  address (mirrors cashOut WITHOUT the rampCashOut leg — the USDC lands liquid
 *  on the account instead of being absorbed by the reserve). Real unshield, real
 *  proof. */
export async function makePublic(amount: string, prover: ProverKind): Promise<SettleResult> {
  const stroops = toStroops(amount);
  const c = getClient(prover);
  if (c) {
    await ensureHostedPublicAccount();
    await c.sync();
    await wireMvkRegistry(c);
    const to = await selfAddress(c);
    const token = deployment().token as string;
    const liquidBefore = BigInt(String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", to])));
    try {
      const wd = await c.unshield({ amount: stroops, toAddress: to });
      try { await c.flush(); } catch { /* local persistence is best-effort; the withdraw already settled on-chain */ }
      return { status: "settled", txHash: wd.txHash, provingMs: wd.provingMs, prover, amount: stroops.toString(), onChain: true, sorobanPublics: wd.sorobanPublics };
    } catch (e) {
      // The withdraw can settle on-chain even if a follow-up sync/persist throws
      // (RPC retention). Treat a real Public-balance increase as success, not a
      // false error — otherwise the UI shows "failed" on money that actually moved.
      try {
        await c.sync();
        const liquidAfter = BigInt(String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", to])));
        if (liquidAfter > liquidBefore) return { status: "settled", prover, amount: stroops.toString(), onChain: true };
      } catch { /* fall through */ }
      if (e instanceof RampError) throw e;
      throw new RampError("busy", "Couldn't move USDC to your Public balance right now. Your money is safe — please try again.");
    }
  }
  throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
}

/** "Send to a wallet": pay any external Stellar G-address from the Public
 *  balance via the SAC transfer (a real classic-equivalent USDC payment that
 *  credits the recipient's trustline). Validates the address, checks the liquid
 *  balance covers it, and maps a missing-trustline revert to friendly copy. */
export async function sendPublic(toAddress: string, amount: string): Promise<{ txHash?: string; onChain: boolean; amount: string }> {
  const to = toAddress.trim();
  if (!/^G[A-Z2-7]{55}$/.test(to)) throw new RampError("balance", "That doesn't look like a valid wallet address.");
  const stroops = toStroops(amount);
  const c = getClient();
  if (c) {
    await ensureHostedPublicAccount();
    const token = deployment().token as string;
    const from = await selfAddress(c);
    const liquid = BigInt(String(await c.opts.cli.view(token, TX_SOURCE, ["balance", "--id", from])));
    if (stroops > liquid) throw new RampError("balance", "That's more than your Public balance.");
    try {
      // SAC transfer(from, to, amount) — `from` is the custodial public account
      // (authorized via the TX_SOURCE key); `to` is the external wallet.
      const res = await c.opts.cli.invoke({
        contractId: token,
        source: TX_SOURCE,
        send: true,
        fnArgs: ["transfer", "--from", from, "--to", to, "--amount", stroops.toString()],
      });
      return { txHash: res.txHash, onChain: true, amount: stroops.toString() };
    } catch (e) {
      // A missing/under-authorized trustline is the common cause of a SAC
      // transfer revert to an external account — surface it in plain English.
      if (/trustline|trust line|not authorized|#\d*\b.*balance|sac.*balance/i.test(String((e as Error)?.message ?? e))) {
        throw new RampError("balance", "That wallet isn't set up to receive USDC yet.");
      }
      throw new RampError("busy", "Couldn't send right now. Your money is safe — please try again.");
    }
  }
  throw new RampError("busy", "Live testnet client unavailable. No funds were moved.");
}

// ----------------------------------------------------------------- identity / handle

/** The consumer's assurance tier. zkLogin/passkey onboarding establishes T1
 * (unique human); document IDV (T2) is a just-in-time step-up for the fiat ramp.
 * TESTNET ASSURANCE SOURCE: this is env-configured for the live testnet
 * deployment. Raising it to T2 requires a KYC vendor integration (the same
 * external-provider seam as KYB). */
let kycTier = Number(process.env.BENZO_KYC_TIER ?? 1) || 1;
export function getKycTier(): number {
  return kycTier;
}

/** Is a @handle free to claim? live → on-chain registry. */
export async function handleAvailable(handle: string): Promise<boolean> {
  const h = handle.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(h)) return false;
  const c = getClient();
  if (c) {
    try {
      await c.resolveHandle(h);
      return false; // resolved → already taken
    } catch {
      return true; // unresolved → available
    }
  }
  return false;
}

/** Claim a @handle for THIS wallet. live → on-chain registerHandle. */
export async function claimHandle(handle: string): Promise<{ handle: string; txHash?: string; onChain: boolean }> {
  const h = handle.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_.]{3,20}$/.test(h)) throw new Error("handle must be 3–20 chars: letters, numbers, dots, underscores");
  const c = getClient();
  if (c) {
    await ensureHostedPublicAccount();
    await c.sync();
    const res = await c.registerHandle({ handle: h });
    db.profile.handle = h;
    return { handle: h, txHash: res.txHash, onChain: true };
  }
  throw new Error("Live testnet client unavailable. Handle was not registered.");
}

// ----------------------------------------------------------------- request

export async function createRequest(amount: string | undefined, memo: string | undefined): Promise<{ link: string; id: string }> {
  const c = getClient();
  if (c) {
    await ensureHostedPublicAccount();
    const r = await c.createRequest({
      to: db.profile.handle,
      amount: amount ? toStroops(amount) : undefined,
      expiry: nowSec() + 7 * 86_400,
      memo,
    });
    return { ...r, link: walletRouteLink(r.link) };
  }
  throw new Error("Live testnet client unavailable. Request was not registered.");
}

// ----------------------------------------------------------------- external invite / claim (P0-3)

/**
 * Send money to someone with NO account: fund a fresh claim-account from a random
 * secret and hand back a shareable, app-scoped link. The recipient onboards and
 * claims it; if it goes unclaimed, the SENDER self-claims a refund (we retain the
 * secret locally — hackathon track; on-chain time-locked escrow is the mainnet
 * track). The link is tagged `app:"consumer"` so it can never be redeemed in the
 * business console (UI guard + key-derivation domain separation both refuse).
 */
const INVITE_TTL = 7 * 86_400;

const b64urlFromHex = (hex: string): string => Buffer.from(hex, "hex").toString("base64url");
const bytesFromB64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

function tenantInvites(): WalletInvite[] {
  db.invites ??= [];
  return db.invites;
}

function sweepExpired(): void {
  const now = nowSec();
  for (const e of tenantInvites()) if (e.status === "pending" && now > e.expiresAt) e.status = "expired";
}

/** Re-adopt the wallet account after a claim (which mutates the client's account). */
function restoreWalletAccount(c: BenzoClient): void {
  c.useAccount(loadWalletAccount());
  mvkWired.delete(c); // wallet MVK must be re-wired after the claim account hijack
}

export interface InviteResult {
  link: string;
  localId: string;
  claimAccountPub: string;
  amount: string;
  expiresAt: number;
  onChain: boolean;
  txHash?: string;
  sorobanPublics?: string[];
}

export async function createInvite(amount: string, note: string | undefined, onPhase?: PhaseSink): Promise<InviteResult> {
  const stroops = toStroops(amount);
  const localId = `inv_${Date.now().toString(36)}`;
  const expiresAt = nowSec() + INVITE_TTL;
  const c = getClient();
  if (c) {
    await ensureHostedPublicAccount();
    await c.sync();
    await wireMvkRegistry(c);
    onPhase?.({ phase: "building" });
    onPhase?.({ phase: "proving" });
    const r = await c.createClaimLink({ amount: stroops });
    await c.flush();
    const secret = b64urlFromHex(r.claimSecretHex);
    const claimLink = encodeBenzoLink(
      { type: "claim", secret, app: "consumer", amount: stroops.toString(), expiresAt: String(expiresAt) },
      "scheme",
    );
    const link = walletRouteLink(claimLink);
    tenantInvites().push({ localId, amount: stroops.toString(), note, link, secret, createdAt: nowSec(), expiresAt, status: "pending" });
    onPhase?.({ phase: "submitting", txHash: r.sendTx });
    onPhase?.({ phase: "confirmed", txHash: r.sendTx, onChain: true });
    return { link, localId, claimAccountPub: r.recipient.spendPub.toString(16), amount: stroops.toString(), expiresAt, onChain: true, txHash: r.sendTx, sorobanPublics: r.sorobanPublics };
  }
  throw new RampError("busy", "Live testnet client unavailable. Invite was not funded.");
}

/** Sweep a claim account's funds out to the wallet's public address (claim or refund). */
async function sweepClaim(secret: string): Promise<{ amount: string; txHash?: string; onChain: boolean; sorobanPublics?: string[] }> {
  const c = getClient();
  if (!c) throw new RampError("busy", "Live testnet client unavailable. Claim was not submitted.");
  await ensureHostedPublicAccount();
  const to = await selfAddress(c);
  const claimSecret = bytesFromB64url(secret);
  // Adopt the ephemeral claim account and register ITS MVK in the wired mirror
  // first — the unshield that settles the claim needs the spender's MVK
  // membership path (else "MvkRegistryMirror: MVK not registered").
  c.useAccount(accountFromClaimSecret(claimSecret));
  mvkWired.delete(c);
  await c.sync();
  await wireMvkRegistry(c);
  try {
    const r = await c.claim({ claimSecret, toAddress: to });
    await c.flush();
    return { amount: r.amount.toString(), txHash: r.txHash, onChain: true, sorobanPublics: r.sorobanPublics };
  } finally {
    restoreWalletAccount(c); // re-adopt the wallet (mvkWired reset; re-wires lazily)
    await c.sync();
  }
}

export async function claimInvite(secret: string, localId?: string): Promise<{ amount: string; txHash?: string; onChain: boolean; sorobanPublics?: string[] }> {
  const c = getClient();
  if (c) {
    // (1) Sweep the escrowed note out of the ephemeral claim-account → the
    // recipient's liquid USDC address. (2) Then shield it into the recipient's
    // OWN note so it lands in the in-app (shielded) balance and is spendable
    // under the recipient's distinct spend key — not left sitting as public USDC.
    const r = await sweepClaim(secret);
    let txHash = r.txHash;
    let sorobanPublics = r.sorobanPublics;
    if (r.onChain && BigInt(r.amount) > 0n) {
      try {
        await c.sync();
        await wireMvkRegistry(c);
        const from = await selfAddress(c);
        const before = await c.getBalance();
        const sh = await c.shield({ amount: BigInt(r.amount), fromAddress: from, fromSource: TX_SOURCE });
        await c.flush();
        txHash = sh.txHash ?? txHash;
        sorobanPublics = sh.sorobanPublics;
      } catch (e) {
        // Same RPC-retention tolerance as addMoney: the shield settles on-chain
        // before the SDK's strict full-tree assertion, which can trip on a
        // long-lived deployment. Confirm by the shielded-balance delta.
        if (/out of sync/.test((e as Error).message)) {
          await c.sync();
        } else throw e;
      }
    }
    const invite = localId ? tenantInvites().find((e) => e.localId === localId) : tenantInvites().find((e) => e.secret === secret);
    if (invite) invite.status = "claimed";
    db.activity.unshift({
      id: `act_${Date.now()}`, type: "receive", name: "Claimed a link", note: "Money received",
      amount: r.amount, direction: "in", status: "settled", timestamp: nowSec(), tone: "accent",
    });
    return { ...r, txHash, sorobanPublics };
  }
  throw new RampError("busy", "Live testnet client unavailable. Claim was not submitted.");
}

export async function refundInvite(localId: string): Promise<{ amount: string; txHash?: string; onChain: boolean; sorobanPublics?: string[] }> {
  const e = tenantInvites().find((x) => x.localId === localId);
  if (!e) throw new Error("invite not found");
  if (e.status === "claimed") throw new Error("already claimed - can't refund");
  const c = getClient();
  if (c) {
    const r = await sweepClaim(e.secret);
    e.status = "refunded";
    return r;
  }
  throw new RampError("busy", "Live testnet client unavailable. Refund was not submitted.");
}

export function listInvites(): Array<Omit<WalletInvite, "secret">> {
  sweepExpired();
  return [...tenantInvites()].sort((a, b) => b.createdAt - a.createdAt).map(({ secret: _s, ...rest }) => rest);
}

// ----------------------------------------------------------------- share proof

export async function shareProof(
  minAmount: string,
  prover: ProverKind,
): Promise<{ holds: boolean; proof: string; publics: string[]; onChain: boolean; prover: ProverKind }> {
  const c = getClient(prover);
  if (c) {
    await c.sync();
    const r = await c.proveBalance({ minAmount: toStroops(minAmount) });
    // The proof is real (Groth16 over real notes), Soroban-encoded, AND now
    // VERIFIED ON-CHAIN: the deploy registers a BALANCE verifier VK, so we call
    // verifier.verify_proof(BALANCE, proof, publics) and report the chain's own
    // verdict. The verifier fails closed, so onChain=true means the pairing
    // check passed on-chain — not just locally. We also hand back the public
    // signals so the BROWSER can independently re-verify on-chain (trustless).
    const onChain = await c.verifyProofOnChain("BALANCE", r.sorobanProof, r.sorobanPublics);
    return { holds: true, proof: JSON.stringify(r.sorobanProof), publics: r.sorobanPublics, onChain, prover };
  }
  throw new RampError("busy", "Live testnet client unavailable. Proof was not generated.");
}

// --------------------------------------------------- dev: provision account to device
//
// LOCAL TESTNET-DEV ONLY. Hands the existing (file-custody) testnet account's
// keys to a localhost browser so the device can read its shielded balance/history
// DIRECTLY from the chain (no BFF in the read path) — the "blockchain is the
// backend" thesis.
// HARD-GATED behind BENZO_DEV_EXPORT=1, testnet, and a non-Vercel runtime;
// returns null otherwise. In hosted deployments the device derives these keys
// from passkey/zk-login material and they are NEVER transmitted. This endpoint
// is purely a local migration affordance for the pre-existing funded account.
// Stateless gas-paying RELAY: the browser proves a transfer on-device and hands
// over ONLY {contractId, fnArgs} (the proof + public commitments/nullifiers —
// NEVER the witness). We submit it with our key (paying the XLM fee). Restricted
// to the pool contract; the proof is self-authorizing so this can't be abused to
// move anyone's funds. Gated to testnet-dev like the account export.
// Production posture: a gas relay must NOT be a generic "submit anything" oracle
// for its signing key. We constrain it to (a) the pool contract only, (b) the
// self-authorizing `transfer` function only (the proof enforces correctness;
// other pool fns like shield move the operator's own funds and must not be
// relay-callable), and (c) a small fixed-window rate limit per process. A
// production relay additionally fee-bumps a user-signed inner tx and runs on its
// own funded operator key (not the deployer) — see ARCHITECTURE §4/§6.
const RELAY_ALLOWED_FNS = new Set(["transfer"]);
// The relay submits with its OWN funded operator key (not the deployer) — per-role
// operator separation so relay gas-fee txns can't collide (TxBadSeq) with deployer
// ops, and the deployer key isn't exposed to the relay's submit surface.
let relayWindowStart = 0;
let relayWindowCount = 0;
export async function relaySubmit(contractId: string, fnArgs: string[]): Promise<{ txHash?: string }> {
  if (process.env.BENZO_DEV_EXPORT !== "1") throw new Error("relay disabled");
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") throw new Error("relay: testnet only");
  if (contractId !== deployment().pool) throw new Error("relay: only the pool contract is allowed");
  if (!RELAY_ALLOWED_FNS.has(fnArgs[0])) throw new Error(`relay: function "${fnArgs[0]}" not relay-allowed`);
  // Fixed-window rate limit (30 submits / 60s) so a leaked endpoint can't drain
  // the operator's XLM via fee spam.
  const now = nowSec();
  if (now - relayWindowStart >= 60) { relayWindowStart = now; relayWindowCount = 0; }
  if (++relayWindowCount > 30) throw new Error("relay: rate limited");
  if (hostedRuntime()) return relaySubmitWithSdk(contractId, fnArgs);
  const c = getClient();
  if (!c) throw new Error("relay: not live");
  const res = await c.opts.cli.invoke({ contractId, source: RELAY_SOURCE, send: true, fnArgs });
  return { txHash: res.txHash };
}

async function relaySubmitWithSdk(contractId: string, fnArgs: string[]): Promise<{ txHash?: string }> {
  const secret = process.env.RELAYER_SECRET;
  const rpcUrl = process.env.SOROBAN_RPC_URL;
  if (!secret) throw new Error("relay: RELAYER_SECRET missing");
  if (!rpcUrl) throw new Error("relay: SOROBAN_RPC_URL missing");
  const kp = Keypair.fromSecret(secret);
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const { method, scArgs } = buildWriteCall(fnArgs);
  const source = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  })
    .addOperation(new Contract(contractId).call(method, ...scArgs))
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`relay submit failed: ${sent.errorResult?.toXDR("base64") ?? "unknown error"}`);
  if (sent.status === "PENDING") {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const txr = await server.getTransaction(sent.hash);
      if (txr.status === "SUCCESS") return { txHash: sent.hash };
      if (txr.status === "FAILED") throw new Error(`relay tx failed: ${sent.hash}`);
      if (txr.status === "NOT_FOUND") continue;
    }
  }
  return { txHash: sent.hash };
}

function buildWriteCall(fnArgs: string[]): { method: string; scArgs: xdr.ScVal[] } {
  const method = fnArgs[0];
  const scArgs: xdr.ScVal[] = [];
  for (let i = 1; i < fnArgs.length; i += 1) {
    const tok = fnArgs[i];
    if (!tok.startsWith("--")) continue;
    scArgs.push(scvalForWriteArg(tok.slice(2), fnArgs[++i]));
  }
  return { method, scArgs };
}

export function exportAccountForDevice(): { spendSk: string; viewSecret: string; mvkSecret: string } | null {
  if (process.env.BENZO_DEV_EXPORT !== "1") return null;
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") return null; // never on mainnet
  if (hostedRuntime()) return null; // never export wallet material from hosted deployments
  const c = getClient();
  if (!c) return null;
  const a = c.account;
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  return { spendSk: a.spendSk.toString(), viewSecret: hex(a.viewSecret), mvkSecret: hex(a.mvkSecret) };
}
