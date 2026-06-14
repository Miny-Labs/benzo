/**
 * @benzo/relayer — gasless submission for shielded transfers.
 *
 * The relayer is **liveness-only, never custody**: it submits a pre-proven
 * `transfer` transaction (the user's Groth16 proof is self-authorizing — it
 * fixes the nullifiers, output commitments, fee and relayer address) and pays
 * the XLM network fee. It is compensated by the `fee` USDC paid out of the
 * shielded pool to its address. A relayer cannot alter amounts, recipients,
 * or steal funds — the proof would no longer verify.
 *
 * This mirrors the OpenZeppelin Relayer / channel-account submitter role from
 * BENZO.md §7.4, implemented self-hosted with the Stellar CLI.
 */

import {
  completeSponsoredOnboard,
  transferRelayFnArgs,
  type InvokeResult,
  type StellarCli,
} from "@benzo/core";
import { Keypair } from "@stellar/stellar-sdk";

export interface TransferRelayRequest {
  /** the relayer's CLI identity / channel account (pays the XLM fee) */
  relayerSource: string;
  /** the relayer G-address that receives the USDC fee */
  relayerAddress: string;
  pool: string;
  root: string;
  nullifier0: string;
  nullifier1: string;
  outCommitment0: string;
  outCommitment1: string;
  fee: string;
  mvkTag0: string;
  mvkTag1: string;
  noteCt0: string;
  noteCt1: string;
  mvkCt0: string;
  mvkCt1: string;
  /** Soroban-encoded Groth16 proof {a,b,c} as JSON */
  proof: string;
}

export interface RelayResult {
  txHash?: string;
  raw: string;
}

export class BenzoRelayer {
  constructor(readonly cli: StellarCli) {}

  /** Submit a proven transfer, paying gas with the relayer key. */
  async relayTransfer(req: TransferRelayRequest): Promise<RelayResult> {
    const submitter = await this.cli.keyAddress(req.relayerSource);
    const res = await this.cli.invoke({
      contractId: req.pool,
      source: req.relayerSource,
      send: true,
      fnArgs: transferRelayFnArgs({ ...req, submitter }),
    });
    return { txHash: res.txHash, raw: res.raw };
  }
}

// --------------------------------------------------------------- browser ----
// Browser-safe clients (fetch only) for the wallet to call the relayer/sponsor
// HTTP service. No node deps — safe to bundle into the PWA.

/**
 * A ChainClient `submitWrite` that POSTs a proven write (only `transfer`) to the
 * relayer service. Plug into StellarRpcClient so the browser's gasless sends are
 * submitted by the relayer (which pays the fee) without the user holding XLM.
 */
export function relayerSubmitter(baseUrl: string) {
  return async (opts: {
    contractId: string;
    source: string;
    fnArgs: string[];
  }): Promise<InvokeResult> => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`relay failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { result?: unknown; txHash?: string; raw?: string };
    return { result: j.result ?? null, txHash: j.txHash, raw: j.raw ?? "" };
  };
}

/**
 * Non-custodial onboarding from the browser: the wallet generates its own
 * keypair, the sponsor service co-signs the create+trustline tx, and the wallet
 * adds its signature and submits. The server never sees the user's secret.
 */
export async function onboardViaSponsor(
  baseUrl: string,
  params: { newAccountSecret: string; horizonUrl: string; networkPassphrase: string },
): Promise<{ txHash: string; publicKey: string }> {
  const publicKey = Keypair.fromSecret(params.newAccountSecret).publicKey();
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/sponsor/onboard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountPublic: publicKey }),
  });
  if (!res.ok) throw new Error(`onboard failed: ${res.status} ${await res.text()}`);
  const { xdr } = (await res.json()) as { xdr: string };
  const done = await completeSponsoredOnboard({
    horizonUrl: params.horizonUrl,
    networkPassphrase: params.networkPassphrase,
    xdr,
    newAccountSecret: params.newAccountSecret,
  });
  return { txHash: done.txHash, publicKey };
}
