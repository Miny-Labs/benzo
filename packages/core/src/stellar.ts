/**
 * Stellar client — wraps the `stellar` CLI for deploys/invokes (so every
 * transaction is reproducible from a shell) and the Soroban JSON-RPC for
 * reads (events, ledger entries).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface StellarConfig {
  network: string; // e.g. "testnet"
  rpcUrl: string;
  networkPassphrase: string;
  /** stellar CLI binary */
  bin?: string;
}

export interface InvokeResult {
  /** parsed JSON return value of the contract fn (or raw string) */
  result: unknown;
  /** transaction hash if one was submitted */
  txHash?: string;
  raw: string;
}

/**
 * The chain-submission port the core depends on (read + write to Soroban). The
 * CLI/server backs it with `StellarCli` (shells the `stellar` binary); a browser
 * surface backs it with a `@stellar/stellar-sdk` adapter (build → simulate →
 * sign → submit invokeHostFunction; `simulateTransaction` for reads). Core types
 * against this interface so it never hard-depends on `node:child_process`.
 */
export interface ChainClient {
  invoke(opts: {
    contractId: string;
    source: string;
    fnArgs: string[];
    send?: boolean;
  }): Promise<InvokeResult>;
  view(contractId: string, source: string, fnArgs: string[]): Promise<unknown>;
  keyAddress(name: string): Promise<string>;
}

export class StellarCli implements ChainClient {
  constructor(readonly cfg: StellarConfig) {}

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      STELLAR_NETWORK_PASSPHRASE: this.cfg.networkPassphrase,
      SOROBAN_RPC_URL: this.cfg.rpcUrl,
      STELLAR_RPC_URL: this.cfg.rpcUrl,
    };
  }

  private async run(
    args: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const bin = this.cfg.bin ?? "stellar";
    return execFileP(bin, args, {
      env: this.env(),
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 120_000, // never hang forever on a wedged CLI/RPC
    });
  }

  /** Heuristic: is this error a transient network/RPC hiccup worth retrying? */
  private isTransient(e: unknown): boolean {
    const msg = String(
      (e as { stderr?: string; message?: string })?.stderr ??
        (e as { message?: string })?.message ??
        e,
    ).toLowerCase();
    return /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|connection|temporarily|gateway|deadline|error sending request|\b(429|502|503|504)\b/.test(
      msg,
    );
  }

  /**
   * Run a READ-ONLY command with bounded exponential-backoff retry on transient
   * failures. Only safe for idempotent reads (view/keys) — never for submits,
   * which could double-execute.
   */
  private async runRead(
    args: string[],
    opts: { timeoutMs?: number; attempts?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const attempts = opts.attempts ?? 4;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** (i - 1)));
      try {
        return await this.run(args, opts);
      } catch (e) {
        lastErr = e;
        if (!this.isTransient(e)) throw e; // a real (non-transient) error: surface it
      }
    }
    throw lastErr;
  }

  async deploy(opts: {
    wasmPath: string;
    source: string;
    constructorArgs?: string[];
  }): Promise<{ contractId: string; txHash?: string }> {
    const args = [
      "contract",
      "deploy",
      "--wasm",
      opts.wasmPath,
      "--source",
      opts.source,
      "--network",
      this.cfg.network,
    ];
    if (opts.constructorArgs?.length) args.push("--", ...opts.constructorArgs);
    const { stdout, stderr } = await this.run(args);
    const contractId = stdout.trim().split("\n").pop()!.trim();
    const txHash = /Signing transaction: ([0-9a-f]{64})/.exec(stderr)?.[1];
    return { contractId, txHash };
  }

  /**
   * Invoke a contract function. `send` forces submission even for reads.
   * Function args go in `fnArgs` as ["fn_name", "--arg", "value", ...].
   */
  async invoke(opts: {
    contractId: string;
    source: string;
    fnArgs: string[];
    send?: boolean;
  }): Promise<InvokeResult> {
    const args = [
      "contract",
      "invoke",
      "--id",
      opts.contractId,
      "--source",
      opts.source,
      "--network",
      this.cfg.network,
    ];
    if (opts.send) args.push("--send=yes");
    args.push("--", ...opts.fnArgs);
    // Reads (simulations) retry on transient errors; submits run once (a blind
    // retry could double-execute the transaction).
    const { stdout, stderr } = opts.send ? await this.run(args) : await this.runRead(args);
    const raw = stdout.trim();
    let result: unknown = raw;
    try {
      result = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw string */
    }
    const txHash = /Signing transaction: ([0-9a-f]{64})/.exec(stderr)?.[1];
    return { result, txHash, raw };
  }

  /** Read-only simulation invoke (no submission). */
  async view(contractId: string, source: string, fnArgs: string[]): Promise<unknown> {
    const r = await this.invoke({ contractId, source, fnArgs, send: false });
    return r.result;
  }

  async keyAddress(name: string): Promise<string> {
    const { stdout } = await this.runRead(["keys", "address", name]);
    return stdout.trim();
  }

  /** Raw JSON-RPC call against Soroban RPC (idempotent reads; retried + timed out). */
  async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** (i - 1)));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const res = await fetch(this.cfg.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: ctl.signal,
        });
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`rpc ${method}: HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { result?: T; error?: { message: string } };
        if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
        return body.result as T;
      } catch (e) {
        lastErr = e;
        // RPC-level errors (body.error) are non-transient — rethrow immediately.
        if (e instanceof Error && e.message.startsWith(`rpc ${method}:`) && !/HTTP 5|HTTP 429/.test(e.message)) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async latestLedger(): Promise<number> {
    const r = await this.rpc<{ sequence: number }>("getLatestLedger", {});
    return r.sequence;
  }

  /** Fetch contract events (used by the indexer). */
  async getEvents(opts: {
    startLedger: number;
    contractIds: string[];
    limit?: number;
  }): Promise<{
    events: Array<{
      ledger: number;
      id: string;
      contractId: string;
      topic: string[];
      value: string;
      txHash: string;
    }>;
    latestLedger: number;
  }> {
    type RawEvents = {
      events: Array<{
        ledger: number;
        id: string;
        contractId: string;
        topic: string[];
        value: string;
        txHash: string;
      }>;
      latestLedger: number;
    };
    return this.rpc<RawEvents>("getEvents", {
      startLedger: opts.startLedger,
      filters: [{ type: "contract", contractIds: opts.contractIds }],
      pagination: { limit: opts.limit ?? 1000 },
    });
  }
}

/** Build a StellarConfig from the standard Benzo .env variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StellarConfig {
  return {
    network: env.STELLAR_NETWORK ?? "testnet",
    rpcUrl: env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  };
}

/** Read a required env var or throw a clear error (used by the self-hosted
 * servers that guard signing keys, where a missing var otherwise surfaces as a
 * cryptic SDK "invalid encoded string"). */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}
