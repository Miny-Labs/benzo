/**
 * Non-custodial client-side signing for Soroban writes.
 *
 * Background: `StellarRpcClient` delegates writes to an injected `submitWrite`.
 * The MVP wired that to a self-hosted relayer that held a `DEPLOYER_SECRET` and
 * signed on the user's behalf — CUSTODIAL: the operator key could submit any
 * transaction. This module replaces that with a `TxSignerPort` so the *user's
 * own* key (Freighter, a passkey smart account, or a local keypair for
 * CLI/self-host) signs, and the relayer (if used at all) only sponsors fees via
 * a fee-bump it cannot repurpose. The signer never leaves the device.
 *
 * The seam is intentionally Freighter-shaped (`signTransaction(xdr, {network})`)
 * so a browser drops in `@stellar/freighter-api` or `smart-account-kit` with no
 * adapter, while Node/tests use `LocalKeypairSigner`.
 *
 * `makeClientSubmitWrite` produces a `submitWrite` compatible with
 * `StellarRpcOptions.submitWrite`, so flipping a wallet from custodial-relayer
 * to self-signed is a one-line swap with no protocol-logic change.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  type FeeBumpTransaction,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { toHex } from "./crypto/bytes.js";
import { scvalForWriteArg } from "./scval.js";
import type { InvokeResult } from "./stellar.js";

/**
 * A pluggable signer: turns an unsigned transaction XDR into a signed one. This
 * is the custody boundary — core builds and submits, but the *signature* comes
 * from whatever the runtime trusts (a browser extension, a passkey, an HSM, a
 * local key). Deliberately the same shape as `@stellar/freighter-api`'s
 * `signTransaction`, so the browser wallet needs no adapter.
 */
export interface TxSignerPort {
  /** The `G…` address whose authority this signer wields. */
  publicKey(): Promise<string>;
  /** Sign `xdr` for `networkPassphrase`; returns signed transaction XDR. */
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

/**
 * Local Ed25519 signer over a `S…` secret — for the CLI, self-host services,
 * and tests. In the browser you would NOT use this (it holds the raw key);
 * there you pass a `TxSignerPort` backed by Freighter or a passkey instead.
 */
export class LocalKeypairSigner implements TxSignerPort {
  private readonly kp: Keypair;
  constructor(secret: string) {
    this.kp = Keypair.fromSecret(secret);
  }
  static fromSecret(secret: string): LocalKeypairSigner {
    return new LocalKeypairSigner(secret);
  }
  async publicKey(): Promise<string> {
    return this.kp.publicKey();
  }
  async signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
    tx.sign(this.kp);
    return tx.toXDR();
  }
}

/**
 * Adapt a bare Freighter-style `signTransaction(xdr, {networkPassphrase})` and a
 * known address into a `TxSignerPort`. Lets a browser wire the wallet's signer
 * directly without importing it into core.
 */
export function signerFromFn(
  address: string,
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>,
): TxSignerPort {
  return {
    publicKey: async () => address,
    signTransaction: (xdr, opts) => signTransaction(xdr, opts),
  };
}

/** The slice of `rpc.Server` the submit path needs — narrowed so tests can
 *  inject a fake without standing up a chain. */
export interface SubmitRpc {
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<{
    status: string;
    hash: string;
    errorResult?: unknown;
  }>;
  getTransaction(hash: string): Promise<{
    status: string;
    returnValue?: xdr.ScVal;
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nativeResult(retval?: xdr.ScVal): { result: unknown; raw: string } {
  if (!retval) return { result: null, raw: "" };
  const result = scValToNative(retval);
  const raw =
    result === null || result === undefined
      ? ""
      : typeof result === "object"
        ? JSON.stringify(result, (_k, v) =>
            v instanceof Uint8Array ? toHex(v) : typeof v === "bigint" ? v.toString() : v,
          )
        : String(result);
  return { result, raw };
}

/**
 * Sign an already-prepared (simulated + assembled) transaction with the port,
 * submit it, and poll to finality. The signer is the only thing that touches
 * key material; this function is pure transport. Submission normally runs
 * exactly once (a Soroban write is not idempotent — a blind retry could
 * double-execute). The only send retry allowed here is a freshly rebuilt tx
 * after RPC returns `txBadSeq`, which means the rejected inner transaction did
 * not execute.
 */
export async function signAndSubmit(opts: {
  server: SubmitRpc;
  preparedXdr: string;
  retryPreparedXdr?: () => Promise<string>;
  signer: TxSignerPort;
  networkPassphrase: string;
  feeBumpSigner?: TxSignerPort;
  feeBumpBaseFee?: string;
  badSeqRetryDelayMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
}): Promise<InvokeResult> {
  const buildSigned = async (preparedXdr: string): Promise<Transaction | FeeBumpTransaction> => {
    const signedXdr = await opts.signer.signTransaction(preparedXdr, {
      networkPassphrase: opts.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(signedXdr, opts.networkPassphrase) as Transaction;
    if (!opts.feeBumpSigner) return signed;
    const feeSource = await opts.feeBumpSigner.publicKey();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      opts.feeBumpBaseFee ?? BASE_FEE,
      signed,
      opts.networkPassphrase,
    );
    const feeBumpXdr = await opts.feeBumpSigner.signTransaction(feeBump.toXDR(), {
      networkPassphrase: opts.networkPassphrase,
    });
    return TransactionBuilder.fromXDR(feeBumpXdr, opts.networkPassphrase) as FeeBumpTransaction;
  };

  let tx = await buildSigned(opts.preparedXdr);
  let sent = await opts.server.sendTransaction(tx);
  if (sent.status === "ERROR" && opts.retryPreparedXdr && isBadSequenceResult(sent.errorResult)) {
    await sleep(opts.badSeqRetryDelayMs ?? 1000);
    tx = await buildSigned(await opts.retryPreparedXdr());
    sent = await opts.server.sendTransaction(tx);
  }
  for (let i = 0; sent.status === "TRY_AGAIN_LATER" && i < 5; i++) {
    await sleep(1_000 + i * 500);
    sent = await opts.server.sendTransaction(tx);
  }
  if (sent.status === "ERROR" || sent.status === "DUPLICATE" || sent.status === "TRY_AGAIN_LATER") {
    throw new Error(`sendTransaction ${sent.status}: ${JSON.stringify(sent.errorResult ?? {})}`);
  }
  const hash = sent.hash;

  const attempts = opts.pollAttempts ?? 30;
  const interval = opts.pollIntervalMs ?? 1000;
  for (let i = 0; i < attempts; i++) {
    const got = await opts.server.getTransaction(hash);
    if (got.status === "SUCCESS") {
      return { ...nativeResult(got.returnValue), txHash: hash };
    }
    if (got.status === "FAILED") {
      throw new Error(`transaction ${hash} FAILED on-chain`);
    }
    // NOT_FOUND → still settling; back off and retry.
    await sleep(interval);
  }
  throw new Error(`transaction ${hash} not confirmed after ${attempts} polls`);
}

function isBadSequenceResult(result: unknown): boolean {
  return /txBadSeq/.test(JSON.stringify(result ?? {}));
}

/**
 * Build → simulate → assemble a contract invocation into a prepared XDR ready to
 * sign. Args are the same CLI-style `["method","--name","value",…]` tokens core
 * already produces; `scvalForWriteArg` types them (including the `--proof`
 * struct). Returns the assembled (resource-fee + footprint + auth) XDR.
 */
export async function buildInvokeTx(opts: {
  server: rpc.Server;
  contractId: string;
  sourceAddress: string;
  fnArgs: string[];
  networkPassphrase: string;
  fee?: string;
}): Promise<string> {
  const method = opts.fnArgs[0];
  const scArgs: xdr.ScVal[] = [];
  for (let i = 1; i < opts.fnArgs.length; i++) {
    const tok = opts.fnArgs[i];
    if (!tok.startsWith("--")) continue;
    scArgs.push(scvalForWriteArg(tok.slice(2), opts.fnArgs[++i]));
  }

  const account = await opts.server.getAccount(opts.sourceAddress);
  const built = new TransactionBuilder(
    new Account(account.accountId(), account.sequenceNumber()),
    { fee: opts.fee ?? BASE_FEE, networkPassphrase: opts.networkPassphrase },
  )
    .addOperation(new Contract(opts.contractId).call(method, ...scArgs))
    .setTimeout(180)
    .build();

  const sim = await opts.server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method}: ${sim.error}`);
  }
  return rpc.assembleTransaction(built, sim).build().toXDR();
}

/**
 * Produce a `submitWrite` (for `StellarRpcOptions.submitWrite`) that signs
 * client-side with `signer` and submits directly to RPC — no custodial relayer.
 * Drop-in: `new StellarRpcClient({ …, submitWrite: makeClientSubmitWrite({…}) })`.
 */
export function makeClientSubmitWrite(deps: {
  server: rpc.Server;
  signer: TxSignerPort;
  feeBumpSigner?: TxSignerPort;
  feeBumpBaseFee?: string;
  networkPassphrase: string;
  addressFor: (name: string) => string;
}): (opts: { contractId: string; source: string; fnArgs: string[] }) => Promise<InvokeResult> {
  return async ({ contractId, source, fnArgs }) => {
    const prepare = () => buildInvokeTx({
      server: deps.server,
      contractId,
      sourceAddress: deps.addressFor(source),
      fnArgs,
      networkPassphrase: deps.networkPassphrase,
    });
    const preparedXdr = await prepare();
    return signAndSubmit({
      server: deps.server,
      preparedXdr,
      retryPreparedXdr: prepare,
      signer: deps.signer,
      feeBumpSigner: deps.feeBumpSigner,
      feeBumpBaseFee: deps.feeBumpBaseFee,
      networkPassphrase: deps.networkPassphrase,
      pollAttempts: 90,
    });
  };
}
