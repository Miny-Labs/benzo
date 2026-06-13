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

import type { StellarCli } from "@benzo/core";

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
      fnArgs: [
        "transfer",
        "--submitter", submitter,
        "--root", req.root,
        "--nullifier0", req.nullifier0,
        "--nullifier1", req.nullifier1,
        "--out_commitment0", req.outCommitment0,
        "--out_commitment1", req.outCommitment1,
        "--fee", req.fee,
        "--relayer", req.relayerAddress,
        "--mvk_tag0", req.mvkTag0,
        "--mvk_tag1", req.mvkTag1,
        "--note_ct0", req.noteCt0,
        "--note_ct1", req.noteCt1,
        "--mvk_ct0", req.mvkCt0,
        "--mvk_ct1", req.mvkCt1,
        "--proof", req.proof,
      ],
    });
    return { txHash: res.txHash, raw: res.raw };
  }
}
