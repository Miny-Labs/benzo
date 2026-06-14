/**
 * The gasless `transfer` relay argument shape — shared by the in-client relay
 * hook (BenzoClient.makeRelay) and the standalone @benzo/relayer service, so the
 * fnArgs are defined once. Pure + browser-safe.
 */

export interface TransferRelayArgs {
  /** the relayer's submitter G-address (pays the XLM fee) */
  submitter: string;
  root: string;
  nullifier0: string;
  nullifier1: string;
  outCommitment0: string;
  outCommitment1: string;
  fee: string;
  /** the relayer G-address that receives the USDC fee */
  relayerAddress: string;
  mvkTag0: string;
  mvkTag1: string;
  noteCt0: string;
  noteCt1: string;
  mvkCt0: string;
  mvkCt1: string;
  /** Soroban-encoded Groth16 proof {a,b,c} as JSON */
  proof: string;
}

/** Build the CLI-style fnArgs for a `pool.transfer` relay submission. */
export function transferRelayFnArgs(a: TransferRelayArgs): string[] {
  return [
    "transfer",
    "--submitter", a.submitter,
    "--root", a.root,
    "--nullifier0", a.nullifier0,
    "--nullifier1", a.nullifier1,
    "--out_commitment0", a.outCommitment0,
    "--out_commitment1", a.outCommitment1,
    "--fee", a.fee,
    "--relayer", a.relayerAddress,
    "--mvk_tag0", a.mvkTag0,
    "--mvk_tag1", a.mvkTag1,
    "--note_ct0", a.noteCt0,
    "--note_ct1", a.noteCt1,
    "--mvk_ct0", a.mvkCt0,
    "--mvk_ct1", a.mvkCt1,
    "--proof", a.proof,
  ];
}
