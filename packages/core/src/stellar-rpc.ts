/**
 * Browser-friendly ChainClient over Soroban RPC (@stellar/stellar-sdk).
 *
 * The CLI-backed StellarCli shells the `stellar` binary (impossible in a
 * browser). This adapter implements the same ChainClient interface using the
 * JSON-RPC server directly:
 *   - reads (`view`) run as a `simulateTransaction` — no signing, no fees, no
 *     contract-spec fetch (the SDK's spec parser chokes on our >10-fn specs);
 *     contract args are coerced to ScVals from the same CLI-style string args
 *     core already builds.
 *   - writes (`invoke … send:true`) are DELEGATED to an injected submitter —
 *     in the wallet that's the self-hosted relayer/sponsor service, which pays
 *     the fee and submits via the proven Node path. The browser only ever hands
 *     over the proof + public inputs (never the witness), so privacy holds and
 *     the user needs no XLM.
 *
 * Works in Node too (the SDK is isomorphic), so the read path is testable
 * headlessly against testnet.
 */

import { toHex } from "./crypto/bytes.js";
import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { scvalForWriteArg } from "./scval.js";
import type { ChainClient, InvokeResult } from "./stellar.js";

export interface StellarRpcOptions {
  rpcUrl: string;
  networkPassphrase: string;
  /** resolve a source NAME to its public `G…` address (the wallet's active account). */
  addressFor: (name: string) => string;
  /**
   * Submit a write op. In the browser this POSTs to the relayer/sponsor service
   * (gasless); omitted = reads-only (writes throw). Receives the same CLI-style
   * fnArgs core already produces, so the server reuses its proven submit path.
   */
  submitWrite?: (opts: {
    contractId: string;
    source: string;
    fnArgs: string[];
  }) => Promise<InvokeResult>;
}

/** Recursively turn Bytes (Uint8Array) into hex strings so RPC-native
 * results match the shape callers expect from the CLI (which returns hex). */
function hexifyDeep(v: unknown): unknown {
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return v.map(hexifyDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = hexifyDeep(val);
    return out;
  }
  return v;
}

export class StellarRpcClient implements ChainClient {
  private readonly server: rpc.Server;

  constructor(private readonly opts: StellarRpcOptions) {
    this.server = new rpc.Server(opts.rpcUrl, {
      allowHttp: opts.rpcUrl.startsWith("http://"),
    });
  }

  private netChecked?: Promise<void>;

  /**
   * One-time guard: the RPC's network passphrase must match the one the client
   * is configured for, else every read/write silently targets the wrong network
   * (e.g. a wallet built for testnet pointed at futurenet). Memoized; a transient
   * failure of the check itself is retried by the caller.
   */
  private async assertNetwork(): Promise<void> {
    if (!this.netChecked) {
      this.netChecked = (async () => {
        const net = await this.server.getNetwork();
        if (net.passphrase !== this.opts.networkPassphrase) {
          throw new Error(
            `network mismatch: RPC reports "${net.passphrase}" but client is configured for "${this.opts.networkPassphrase}"`,
          );
        }
      })().catch((e) => {
        this.netChecked = undefined; // allow a later retry if the check itself was transient
        throw e;
      });
    }
    return this.netChecked;
  }

  /** Heuristic: a transient network/RPC hiccup worth retrying (mirrors StellarCli). */
  private isTransient(e: unknown): boolean {
    const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
    return /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|connection|temporarily|gateway|deadline|fetch failed|network ?error|\b(429|502|503|504)\b/.test(
      msg,
    );
  }

  async keyAddress(name: string): Promise<string> {
    return this.opts.addressFor(name);
  }

  async view(contractId: string, source: string, fnArgs: string[]): Promise<unknown> {
    return (await this.simulate(contractId, source, fnArgs)).result;
  }

  async invoke(opts: {
    contractId: string;
    source: string;
    fnArgs: string[];
    send?: boolean;
  }): Promise<InvokeResult> {
    if (!opts.send) return this.simulate(opts.contractId, opts.source, opts.fnArgs);
    if (!this.opts.submitWrite) {
      throw new Error(
        "StellarRpcClient: no write submitter configured — the browser submits writes via the relayer/sponsor service",
      );
    }
    return this.opts.submitWrite({
      contractId: opts.contractId,
      source: opts.source,
      fnArgs: opts.fnArgs,
    });
  }

  private async simulate(
    contractId: string,
    source: string,
    fnArgs: string[],
  ): Promise<InvokeResult> {
    const { method, scArgs } = this.buildCall(fnArgs);
    // Bounded exponential-backoff retry on transient RPC errors (mirrors the
    // Node StellarCli.runRead); a real simulation/contract error is surfaced
    // immediately (never retried). Safe because simulate is read-only.
    const attempts = 4;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** (i - 1)));
      try {
        await this.assertNetwork();
        const account = new Account(this.opts.addressFor(source), "0"); // sequence irrelevant for simulate
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.opts.networkPassphrase,
        })
          .addOperation(new Contract(contractId).call(method, ...scArgs))
          .setTimeout(30)
          .build();
        const sim = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) {
          // A simulation error is a real contract/account error, not a network
          // hiccup — classify the common not-funded / missing-contract case so
          // the caller gets an actionable message instead of a raw host trap.
          const hint = /account not found|MissingValue|no such|trustline/i.test(sim.error)
            ? " (is the source account funded, with a USDC trustline, on this network?)"
            : "";
          throw new Error(`simulate ${method}: ${sim.error}${hint}`);
        }
        const retval = sim.result?.retval;
        const result = retval ? hexifyDeep(scValToNative(retval)) : null;
        const raw =
          result === null
            ? ""
            : typeof result === "object"
              ? JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
              : String(result);
        return { result, raw };
      } catch (e) {
        lastErr = e;
        if (!this.isTransient(e)) throw e; // a real (non-transient) error: surface it
      }
    }
    throw lastErr;
  }

  /** Parse ["method","--name","value",…] into a method + coerced ScVal args. */
  private buildCall(fnArgs: string[]): { method: string; scArgs: xdr.ScVal[] } {
    const method = fnArgs[0];
    const scArgs: xdr.ScVal[] = [];
    for (let i = 1; i < fnArgs.length; i++) {
      const tok = fnArgs[i];
      if (!tok.startsWith("--")) continue;
      // scvalForWriteArg = the read table PLUS the Groth16 `--proof` struct, so
      // the browser can call verify_proof (and build writes) client-side.
      scArgs.push(scvalForWriteArg(tok.slice(2), fnArgs[++i]));
    }
    return { method, scArgs };
  }
}
