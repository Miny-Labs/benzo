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

import {
  Account,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
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

/** Recursively turn Bytes (Buffer/Uint8Array) into hex strings so RPC-native
 * results match the shape callers expect from the CLI (which returns hex). */
function hexifyDeep(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
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
      throw new Error(`simulate ${method}: ${sim.error}`);
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
  }

  /** Parse ["method","--name","value",…] into a method + coerced ScVal args. */
  private buildCall(fnArgs: string[]): { method: string; scArgs: xdr.ScVal[] } {
    const method = fnArgs[0];
    const scArgs: xdr.ScVal[] = [];
    for (let i = 1; i < fnArgs.length; i++) {
      const tok = fnArgs[i];
      if (!tok.startsWith("--")) continue;
      const value = fnArgs[++i];
      scArgs.push(coerceArg(value));
    }
    return { method, scArgs };
  }
}

/**
 * Coerce a CLI-style string arg into an ScVal. Read args across the protocol are
 * an address, a field-element / U256 (decimal), or a short string (a @handle) —
 * inferred from the value. (Writes go through the relayer, which types args via
 * the on-chain spec, so this only needs to cover the read surface.)
 */
function coerceArg(value: string): xdr.ScVal {
  if (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)) {
    return nativeToScVal(value, { type: "address" });
  }
  if (/^\d+$/.test(value)) {
    return nativeToScVal(BigInt(value), { type: "u256" });
  }
  return nativeToScVal(value, { type: "string" });
}
