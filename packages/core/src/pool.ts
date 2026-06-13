/**
 * High-level Benzo pool client: builds witnesses, proves headlessly, and
 * submits shield / transfer / unshield transactions via the Stellar CLI.
 *
 * The client keeps off-chain mirrors of the pool Merkle tree and the ASP
 * membership tree (same Poseidon2, same zero table) and cross-checks the
 * mirror root against the on-chain root after every operation.
 */

import { MerkleTreeMirror } from "./merkle.js";
import {
  type Note,
  deriveKeypair,
  mvkTag,

  noteCommitment,
  noteNullifier,
  randomFieldElement,
} from "./notes.js";
import { prove, toWitnessInput, type CircuitArtifacts, type ProveResult } from "./prover.js";
import type { StellarCli } from "./stellar.js";

export interface BenzoDeployment {
  pool: string;
  verifier: string;
  merkle: string;
  nullifierSet: string;
  aspMembership: string;
  aspNonMembership: string;
  viewkeyAnchor: string;
  token: string;
  treeLevels: number; // 32
  aspLevels: number; // 16
  smtLevels: number; // 16
}

export interface SpendableNote {
  note: Note;
  spendSk: bigint;
  leafIndex: number;
}

export interface CircuitSet {
  shield: CircuitArtifacts;
  joinsplit: CircuitArtifacts;
  unshield: CircuitArtifacts;
}

function hexBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export class BenzoPoolClient {
  readonly poolTree: MerkleTreeMirror;
  readonly aspTree: MerkleTreeMirror;

  constructor(
    readonly cli: StellarCli,
    readonly dep: BenzoDeployment,
    readonly circuits: CircuitSet,
    /** identity used for read-only simulations */
    readonly viewSource: string,
  ) {
    this.poolTree = new MerkleTreeMirror(dep.treeLevels);
    this.aspTree = new MerkleTreeMirror(dep.aspLevels);
  }

  async assetId(): Promise<bigint> {
    const v = await this.cli.view(this.dep.pool, this.viewSource, ["asset_id"]);
    return BigInt(v as string);
  }

  async depositorScalar(address: string): Promise<bigint> {
    const v = await this.cli.view(this.dep.pool, this.viewSource, [
      "address_scalar",
      "--address",
      address,
    ]);
    return BigInt(v as string);
  }

  async onchainPoolRoot(): Promise<bigint> {
    const v = await this.cli.view(this.dep.merkle, this.viewSource, ["current_root"]);
    return BigInt(v as string);
  }

  async aspAllowRoot(): Promise<bigint> {
    const v = await this.cli.view(this.dep.aspMembership, this.viewSource, ["get_root"]);
    return BigInt(v as string);
  }

  async aspDenyRoot(): Promise<bigint> {
    const v = await this.cli.view(this.dep.aspNonMembership, this.viewSource, ["get_root"]);
    return BigInt(v as string);
  }

  /** Assert the local mirror equals the chain (fails loudly on drift). */
  async assertSynced(): Promise<void> {
    const onchain = await this.onchainPoolRoot();
    const local = this.poolTree.root();
    if (onchain !== local) {
      throw new Error(
        `pool tree mirror out of sync: onchain=${onchain} local=${local}`,
      );
    }
  }

  /** Mirror an ASP membership insert that the curator performed on-chain. */
  aspMirrorInsert(leaf: bigint): number {
    return this.aspTree.insert(leaf);
  }

  /** Reset and rebuild the ASP allow-tree mirror from an ordered leaf list. */
  aspRebuild(leaves: bigint[]): void {
    this.aspTree.leaves = [];
    for (const l of leaves) this.aspTree.insert(l);
  }

  /** Reset and rebuild the pool tree mirror from an ordered commitment list. */
  poolRebuild(leaves: bigint[]): void {
    this.poolTree.leaves = [];
    for (const l of leaves) this.poolTree.insert(l);
  }

  // ------------------------------------------------------------ shield ----

  async shield(opts: {
    source: string; // CLI identity of the depositor (auth)
    from: string; // depositor G-address
    note: Note; // prepared via newNote(amount, recipientPk, assetId)
    mvkPubScalar: bigint;
    aspBlinding: bigint;
    aspLeafIndex: number;
    noteCt: Uint8Array;
    mvkCt: Uint8Array;
  }): Promise<{
    txHash?: string;
    leafIndex: number;
    note: Note;
    proof: ProveResult;
    commitment: bigint;
    tag: bigint;
    provingMs: number;
  }> {
    const assetId = await this.assetId();
    const note = opts.note;
    if (note.assetId !== assetId) throw new Error("note assetId mismatch");
    const commitment = noteCommitment(note);
    const tag = mvkTag(opts.mvkPubScalar, note.blinding);
    const depositor = await this.depositorScalar(opts.from);
    const allowRoot = await this.aspAllowRoot();

    const aspPath = this.aspTree.path(opts.aspLeafIndex);
    if (this.aspTree.root() !== allowRoot) {
      throw new Error("ASP membership mirror out of sync with on-chain root");
    }

    const witness = toWitnessInput({
      commitment,
      amount: note.amount,
      assetId,
      depositor,
      aspMembershipRoot: allowRoot,
      mvkTag: tag,
      recipientPk: note.recipientPk,
      blinding: note.blinding,
      mvkPub: opts.mvkPubScalar,
      aspBlinding: opts.aspBlinding,
      aspPathElements: aspPath.pathElements,
      aspPathIndices: aspPath.pathIndices,
    });
    const _ps = Date.now();
    const proof = await prove(this.circuits.shield, witness);
    const provingMs = Date.now() - _ps;

    const res = await this.cli.invoke({
      contractId: this.dep.pool,
      source: opts.source,
      send: true,
      fnArgs: [
        "shield",
        "--from", opts.from,
        "--amount", note.amount.toString(),
        "--commitment", commitment.toString(),
        "--mvk_tag", tag.toString(),
        "--note_ct", hexBytes(opts.noteCt),
        "--mvk_ct", hexBytes(opts.mvkCt),
        "--asp_membership_root", allowRoot.toString(),
        "--proof", JSON.stringify(proof.sorobanProof),
      ],
    });
    const leafIndex = Number(res.result);
    this.poolTree.insert(commitment);
    await this.assertSynced();
    return { txHash: res.txHash, leafIndex, note, proof, commitment, tag, provingMs };
  }

  // ---------------------------------------------------------- transfer ----

  async transfer(opts: {
    source: string; // submitter identity (relayer or sender)
    inputs: [SpendableNote, SpendableNote]; // pad with dummy via makeDummyInput
    outputs: [
      { note: Note; mvkPubScalar: bigint },
      { note: Note; mvkPubScalar: bigint },
    ];
    fee: bigint;
    relayer: string; // G-address receiving the fee
    noteCts: [Uint8Array, Uint8Array];
    mvkCts: [Uint8Array, Uint8Array];
    /**
     * Optional gasless-relay hook. When provided, the proven transfer is
     * handed to the relayer for submission instead of being submitted by this
     * client — the relayer pays the XLM fee. The proof is self-authorizing, so
     * the relayer cannot alter the transfer.
     */
    relay?: (args: {
      pool: string;
      root: string;
      nullifier0: string;
      nullifier1: string;
      outCommitment0: string;
      outCommitment1: string;
      fee: string;
      relayerAddress: string;
      mvkTag0: string;
      mvkTag1: string;
      noteCt0: string;
      noteCt1: string;
      mvkCt0: string;
      mvkCt1: string;
      proof: string;
    }) => Promise<{ txHash?: string }>;
  }): Promise<{
    txHash?: string;
    outNotes: [Note, Note];
    nullifiers: [bigint, bigint];
    outCommitments: [bigint, bigint];
    outLeafIndices: [number, number];
    proof: ProveResult;
    provingMs: number;
  }> {
    const assetId = await this.assetId();
    const root = this.poolTree.root();

    const outNotes = opts.outputs.map((o) => o.note) as [Note, Note];
    const outCommitments = outNotes.map(noteCommitment) as [bigint, bigint];
    const outTags = outNotes.map((n, i) =>
      mvkTag(opts.outputs[i].mvkPubScalar, n.blinding),
    ) as [bigint, bigint];

    const nullifiers = opts.inputs.map((inp) =>
      noteNullifier(inp.spendSk, BigInt(inp.leafIndex)),
    ) as [bigint, bigint];

    const paths = opts.inputs.map((inp) =>
      inp.note.amount === 0n
        ? {
            pathElements: new Array<bigint>(this.dep.treeLevels).fill(0n),
            pathIndices: BigInt(inp.leafIndex),
          }
        : this.poolTree.path(inp.leafIndex),
    );

    const extHash = await this.cli.view(this.dep.pool, this.viewSource, [
      "transfer_ext_hash",
      "--relayer", opts.relayer,
      "--fee", opts.fee.toString(),
      "--note_ct0", hexBytes(opts.noteCts[0]),
      "--note_ct1", hexBytes(opts.noteCts[1]),
      "--mvk_ct0", hexBytes(opts.mvkCts[0]),
      "--mvk_ct1", hexBytes(opts.mvkCts[1]),
    ]);

    const witness = toWitnessInput({
      root,
      assetId,
      inputNullifier: nullifiers,
      outputCommitment: outCommitments,
      fee: opts.fee,
      extDataHash: BigInt(extHash as string),
      mvkTag: outTags,
      inAmount: opts.inputs.map((i) => i.note.amount),
      inSpendSk: opts.inputs.map((i) => i.spendSk),
      inBlinding: opts.inputs.map((i) => i.note.blinding),
      inPathIndices: paths.map((p) => p.pathIndices),
      inPathElements: paths.map((p) => p.pathElements),
      outAmount: outNotes.map((n) => n.amount),
      outPubkey: outNotes.map((n) => n.recipientPk),
      outBlinding: outNotes.map((n) => n.blinding),
      outMvkPub: opts.outputs.map((o) => o.mvkPubScalar),
    });
    const _pt = Date.now();
    const proof = await prove(this.circuits.joinsplit, witness);
    const provingMs = Date.now() - _pt;

    let txHash: string | undefined;
    if (opts.relay) {
      const r = await opts.relay({
        pool: this.dep.pool,
        root: root.toString(),
        nullifier0: nullifiers[0].toString(),
        nullifier1: nullifiers[1].toString(),
        outCommitment0: outCommitments[0].toString(),
        outCommitment1: outCommitments[1].toString(),
        fee: opts.fee.toString(),
        relayerAddress: opts.relayer,
        mvkTag0: outTags[0].toString(),
        mvkTag1: outTags[1].toString(),
        noteCt0: hexBytes(opts.noteCts[0]),
        noteCt1: hexBytes(opts.noteCts[1]),
        mvkCt0: hexBytes(opts.mvkCts[0]),
        mvkCt1: hexBytes(opts.mvkCts[1]),
        proof: JSON.stringify(proof.sorobanProof),
      });
      txHash = r.txHash;
    } else {
      const res = await this.cli.invoke({
        contractId: this.dep.pool,
        source: opts.source,
        send: true,
        fnArgs: [
          "transfer",
          "--submitter", await this.cli.keyAddress(opts.source),
          "--root", root.toString(),
          "--nullifier0", nullifiers[0].toString(),
          "--nullifier1", nullifiers[1].toString(),
          "--out_commitment0", outCommitments[0].toString(),
          "--out_commitment1", outCommitments[1].toString(),
          "--fee", opts.fee.toString(),
          "--relayer", opts.relayer,
          "--mvk_tag0", outTags[0].toString(),
          "--mvk_tag1", outTags[1].toString(),
          "--note_ct0", hexBytes(opts.noteCts[0]),
          "--note_ct1", hexBytes(opts.noteCts[1]),
          "--mvk_ct0", hexBytes(opts.mvkCts[0]),
          "--mvk_ct1", hexBytes(opts.mvkCts[1]),
          "--proof", JSON.stringify(proof.sorobanProof),
        ],
      });
      txHash = res.txHash;
    }
    const i0 = this.poolTree.insert(outCommitments[0]);
    const i1 = this.poolTree.insert(outCommitments[1]);
    await this.assertSynced();
    return {
      txHash,
      outNotes,
      nullifiers,
      outCommitments,
      outLeafIndices: [i0, i1],
      proof,
      provingMs,
    };
  }

  /** A zero-amount dummy input with a fresh random key (pads 1-in spends). */
  makeDummyInput(assetId: bigint): SpendableNote {
    const kp = deriveKeypair(randomFieldElement());
    return {
      note: {
        amount: 0n,
        recipientPk: kp.publicKey,
        blinding: randomFieldElement(),
        assetId,
      },
      spendSk: kp.spendSk,
      // random in-range index; the root check is disabled for amount == 0
      leafIndex: Number(randomFieldElement() % BigInt(2 ** 31)),
    };
  }

  // ---------------------------------------------------------- withdraw ----

  async withdraw(opts: {
    source: string;
    input: SpendableNote;
    amount: bigint; // public amount released
    to: string; // recipient G-address
    changeNote: Note; // prepared change note (amount must be input - amount)
    changeMvkPubScalar: bigint;
    changeNoteCt: Uint8Array;
    changeMvkCt: Uint8Array;
  }): Promise<{
    txHash?: string;
    nullifier: bigint;
    changeNote: Note;
    changeCommitment: bigint;
    proof: ProveResult;
    provingMs: number;
  }> {
    const assetId = await this.assetId();
    const root = this.poolTree.root();
    const denyRoot = await this.aspDenyRoot();

    const changeAmount = opts.input.note.amount - opts.amount;
    if (changeAmount < 0n) throw new Error("withdraw exceeds note amount");
    const changeNote = opts.changeNote;
    if (changeNote.amount !== changeAmount) throw new Error("change note amount mismatch");
    const changeCommitment = noteCommitment(changeNote);
    const changeTag = mvkTag(opts.changeMvkPubScalar, changeNote.blinding);
    const nullifier = noteNullifier(opts.input.spendSk, BigInt(opts.input.leafIndex));
    const path = this.poolTree.path(opts.input.leafIndex);
    const inCommitment = noteCommitment(opts.input.note);

    // Non-membership witness from the on-chain SMT (proof-of-innocence).
    const fr = (await this.cli.view(this.dep.aspNonMembership, this.viewSource, [
      "find_key",
      "--key",
      inCommitment.toString(),
    ])) as {
      found: boolean;
      siblings: string[];
      not_found_key: string;
      not_found_value: string;
      is_old0: boolean;
    };
    if (fr.found) {
      throw new Error(
        "input note's commitment is in the ASP deny-set; proof-of-innocence impossible",
      );
    }
    const siblings = fr.siblings.map(BigInt);
    while (siblings.length < this.dep.smtLevels) siblings.push(0n);

    const extHash = await this.cli.view(this.dep.pool, this.viewSource, [
      "withdraw_ext_hash",
      "--to", opts.to,
      "--change_note_ct", hexBytes(opts.changeNoteCt),
      "--change_mvk_ct", hexBytes(opts.changeMvkCt),
    ]);

    const witness = toWitnessInput({
      root,
      assetId,
      nullifier,
      publicAmount: opts.amount,
      changeCommitment,
      extDataHash: BigInt(extHash as string),
      aspNonMembershipRoot: denyRoot,
      changeMvkTag: changeTag,
      inAmount: opts.input.note.amount,
      inSpendSk: opts.input.spendSk,
      inBlinding: opts.input.note.blinding,
      inPathIndices: path.pathIndices,
      inPathElements: path.pathElements,
      changeAmount,
      changePubkey: changeNote.recipientPk,
      changeBlinding: changeNote.blinding,
      changeMvkPub: opts.changeMvkPubScalar,
      smtSiblings: siblings,
      smtOldKey: BigInt(fr.not_found_key),
      smtOldValue: BigInt(fr.not_found_value),
      smtIsOld0: fr.is_old0 ? 1n : 0n,
    });
    const _pw = Date.now();
    const proof = await prove(this.circuits.unshield, witness);
    const provingMs = Date.now() - _pw;

    const res = await this.cli.invoke({
      contractId: this.dep.pool,
      source: opts.source,
      send: true,
      fnArgs: [
        "withdraw",
        "--submitter", await this.cli.keyAddress(opts.source),
        "--root", root.toString(),
        "--nullifier", nullifier.toString(),
        "--change_commitment", changeCommitment.toString(),
        "--amount", opts.amount.toString(),
        "--to", opts.to,
        "--change_mvk_tag", changeTag.toString(),
        "--change_note_ct", hexBytes(opts.changeNoteCt),
        "--change_mvk_ct", hexBytes(opts.changeMvkCt),
        "--asp_non_membership_root", denyRoot.toString(),
        "--proof", JSON.stringify(proof.sorobanProof),
      ],
    });
    this.poolTree.insert(changeCommitment);
    await this.assertSynced();
    return { txHash: res.txHash, nullifier, changeNote, changeCommitment, proof, provingMs };
  }
}
