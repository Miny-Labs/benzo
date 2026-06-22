/**
 * High-level Benzo pool client: builds witnesses, proves headlessly, and
 * submits shield / transfer / unshield transactions via the Stellar CLI.
 *
 * The client keeps off-chain mirrors of the pool Merkle tree and the ASP
 * membership tree (same Poseidon2, same zero table) and cross-checks the
 * mirror root against the on-chain root after every operation.
 */

import { toHex } from "./crypto/bytes.js";
import { MerkleTreeMirror } from "./merkle.js";
import { MvkRegistryMirror, DEFAULT_MVK_KEY_META } from "./mvk-registry.js";
import {
  type Note,
  deriveKeypair,
  mvkTag,
  noteCommitment,
  noteNullifier,
  randomFieldElement,
} from "./notes.js";
import { toWitnessInput, type CircuitArtifacts, type ProveResult, type ProverPort } from "./prover.js";
import { transferRelayFnArgs } from "./relay.js";
import {
  type OrgIdentity,
  type OrgSignature,
  orgSpendMessage,
  signOrgSpend,
} from "./org.js";
import { orgNullifier } from "./notes.js";
import type { ChainClient } from "./stellar.js";

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
  /** in-circuit M-of-N org transfer (dual-control treasury spend → pool.transfer_org) */
  joinsplitOrg?: CircuitArtifacts;
  /** optional proof-of-balance circuit (prove funds ≥ threshold) */
  proofOfBalance?: CircuitArtifacts;
  /** optional proof-of-sum circuit (disclose an EXACT total — confidential disclose-total) */
  proofOfSum?: CircuitArtifacts;
  /** optional ORG proof-of-sum (disclose the M-of-N treasury total, ZK, verified on-chain) */
  proofOfSumOrg?: CircuitArtifacts;
  /** optional ORG proof-of-balance (prove treasury ≥ floor: funded / reserves / solvency) */
  proofOfBalanceOrg?: CircuitArtifacts;
  /** optional in-ZK spending policy (prove a payout amount ≤ cap, amount hidden) */
  spendingCap?: CircuitArtifacts;
  /** optional per-payout proof-of-innocence (recipient ∉ sanctions deny SMT) */
  payoutInnocence?: CircuitArtifacts;
  /** optional anonymous M-of-N approval (org_spend_auth: ≥threshold members signed, who hidden) */
  orgSpendAuth?: CircuitArtifacts;
  /** optional verifiable payroll computation (run total + commitments derived from a private rate card) */
  payrollComputation?: CircuitArtifacts;
  /** optional KYB-as-ZK credential (verified business + jurisdiction + tier, docs hidden, sybil nullifier) */
  kybCredential?: CircuitArtifacts;
  /** optional cross-entity private netting (net two parties' invoices, grosses hidden) */
  crossNetting?: CircuitArtifacts;
}

function hexBytes(bytes: Uint8Array): string {
  return toHex(bytes);
}

/** Candidate signer slots in the joinsplit_org circuit (JoinSplitOrg maxSigners). */
export const MAX_ORG_SIGNERS = 3;

/**
 * One org spend, ready to serialise into the pool's `OrgSpend` contract type.
 * U256 fields are decimal strings, `relayer` a G-address, the `*Ct` fields hex
 * `Bytes`, and `proof` the Soroban-encoded Groth16 `{a,b,c}`. `transferOrg`
 * submits one of these; `batchTransferOrg` bundles many into `batch_transfer_org`.
 */
export interface OrgSpendArg {
  root: string;
  nullifier0: string;
  nullifier1: string;
  outCommitment0: string;
  outCommitment1: string;
  fee: string;
  relayer: string;
  mvkTag0: string;
  mvkTag1: string;
  noteCt0: string;
  noteCt1: string;
  mvkCt0: string;
  mvkCt1: string;
  registeredMvkRoot: string;
  proof: unknown;
}

export class BenzoPoolClient {
  readonly poolTree: MerkleTreeMirror;
  readonly aspTree: MerkleTreeMirror;
  /**
   * Optional SHARED authorized-MVK registry mirror. When set (synced from the
   * on-chain `mvk_registry`'s `MvkRegistered` events), shield/transfer/unshield
   * draw `registeredMvkRoot` + the membership path from it, so the root the
   * proof targets is one the deployed pool's `check_mvk_root` already knows.
   * Unset → each op builds a local single-leaf stand-in (well-formed proof, but
   * only valid when the pool has no registry configured). See
   * docs/ZK-AUDIT-AND-STANDARDS.md B.4.
   */
  private mvkRegistry?: MvkRegistryMirror;

  constructor(
    readonly cli: ChainClient,
    readonly dep: BenzoDeployment,
    readonly circuits: CircuitSet,
    /** identity used for read-only simulations */
    readonly viewSource: string,
    /** proving backend (Node / browser WASM / native) */
    readonly prover: ProverPort,
  ) {
    this.poolTree = new MerkleTreeMirror(dep.treeLevels);
    this.aspTree = new MerkleTreeMirror(dep.aspLevels);
  }

  /**
   * Use a shared, on-chain-synced MVK registry mirror for all subsequent money
   * ops. Every MVK a note binds to must already be `register`ed in `mirror`
   * (and on-chain) so its root is a known registry root; `pathFor` throws
   * otherwise — the correct fail-closed behavior for an unregistered key.
   */
  useMvkRegistry(mirror: MvkRegistryMirror): void {
    this.mvkRegistry = mirror;
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

    // Authorized-MVK registry membership (closes the audit P0: the note's MVK
    // must be a registered, nonzero key). A shared synced registry (if set) gives
    // an on-chain-known root; otherwise a single-leaf stand-in keeps the proof
    // well-formed. See docs/ZK-AUDIT-AND-STANDARDS.md B.4.
    const mvkKeyMeta = DEFAULT_MVK_KEY_META;
    const mvkReg = this.mvkRegistry ?? MvkRegistryMirror.singleLeaf(opts.mvkPubScalar, mvkKeyMeta);
    const mvkPath = mvkReg.pathFor(opts.mvkPubScalar);

    const witness = toWitnessInput({
      commitment,
      amount: note.amount,
      assetId,
      depositor,
      aspMembershipRoot: allowRoot,
      mvkTag: tag,
      registeredMvkRoot: mvkReg.root(),
      recipientPk: note.recipientPk,
      blinding: note.blinding,
      mvkPub: opts.mvkPubScalar,
      aspBlinding: opts.aspBlinding,
      aspPathElements: aspPath.pathElements,
      aspPathIndices: aspPath.pathIndices,
      mvkKeyMeta,
      mvkPathElements: mvkPath.pathElements,
      mvkPathIndices: mvkPath.pathIndices,
    });
    const _ps = Date.now();
    const proof = await this.prover.prove(this.circuits.shield, witness);
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
        "--registered_mvk_root", mvkReg.root().toString(),
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
      registeredMvkRoot: string;
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

    // Authorized-MVK registry membership for each output's MVK (closes the audit
    // P0 — see shield). A shared synced registry (if set) yields an on-chain-known
    // root; otherwise build a local one over just this op's outputs.
    const mvkKeyMeta = DEFAULT_MVK_KEY_META;
    let mvkReg: MvkRegistryMirror;
    if (this.mvkRegistry) {
      mvkReg = this.mvkRegistry;
    } else {
      mvkReg = new MvkRegistryMirror();
      for (const o of opts.outputs) mvkReg.register(o.mvkPubScalar, mvkKeyMeta);
    }
    const mvkRegPaths = opts.outputs.map((o) => mvkReg.pathFor(o.mvkPubScalar));

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
      registeredMvkRoot: mvkReg.root(),
      mvkKeyMeta: opts.outputs.map(() => mvkKeyMeta),
      mvkPathElements: mvkRegPaths.map((p) => p.pathElements),
      mvkPathIndices: mvkRegPaths.map((p) => p.pathIndices),
      inAmount: opts.inputs.map((i) => i.note.amount),
      inOrgSpendId: opts.inputs.map((i) => i.spendSk),
      inBlinding: opts.inputs.map((i) => i.note.blinding),
      inPathIndices: paths.map((p) => p.pathIndices),
      inPathElements: paths.map((p) => p.pathElements),
      outAmount: outNotes.map((n) => n.amount),
      outPubkey: outNotes.map((n) => n.recipientPk),
      outBlinding: outNotes.map((n) => n.blinding),
      outMvkPub: opts.outputs.map((o) => o.mvkPubScalar),
    });
    const _pt = Date.now();
    const proof = await this.prover.prove(this.circuits.joinsplit, witness);
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
        registeredMvkRoot: mvkReg.root().toString(),
        proof: JSON.stringify(proof.sorobanProof),
      });
      txHash = r.txHash;
    } else {
      const res = await this.cli.invoke({
        contractId: this.dep.pool,
        source: opts.source,
        send: true,
        fnArgs: transferRelayFnArgs({
          submitter: await this.cli.keyAddress(opts.source),
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
          registeredMvkRoot: mvkReg.root().toString(),
          proof: JSON.stringify(proof.sorobanProof),
        }),
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

  // -------------------------------------------------- transfer_org (M-of-N) ----

  /**
   * Spend an ORG treasury note under in-circuit M-of-N dual control
   * (`pool.transfer_org`, VK `JSPLITORG`). The org note can ONLY move because
   * ≥ threshold distinct members signed the spend message — the cryptographic
   * embodiment of a maker-checker approval, enforced in-circuit, not by a server.
   *
   * input0 = the org note (owner = org.recipientPk); input1 = a genuine zero
   * dummy. The two outputs are the caller's: typically out0 = the payee's note
   * and out1 = a fresh CHANGE org note (recipientPk = org.recipientPk) so the
   * remaining treasury stays confidential AND dual-controlled across payouts.
   *
   * Signatures: by default each candidate member signs internally from its held
   * key; pass `sign(memberIndex, message)` to collect approvals out-of-process
   * (true client-side self-signing per approver). Exactly `MAX_ORG_SIGNERS`
   * candidate slots are presented; `signerIndices` (≥ threshold) are `enabled`.
   */
  /**
   * Build ONE org join-split: validate, assemble the witness, and prove
   * `joinsplit_org` — WITHOUT submitting. Returns the proof + the JSON-ready
   * `OrgSpend` struct (matching the pool's `OrgSpend` contract type) so the
   * caller can either submit a single `transfer_org` (see `transferOrg`) or
   * bundle many into one `batch_transfer_org` (see `batchTransferOrg`). The
   * witness is built against the CURRENT pool root, so a batch must build all
   * its spends BEFORE inserting any output (they all reference the pre-batch
   * root, which stays `is_known_root`).
   */
  private async buildOrgSpend(opts: {
    source: string;
    org: OrgIdentity;
    /** which candidate-member slots approved (length ≥ org.threshold). */
    signerIndices: number[];
    /** the org treasury note being spent + its on-chain leaf. */
    input: { note: Note; leafIndex: number };
    outputs: [
      { note: Note; mvkPubScalar: bigint },
      { note: Note; mvkPubScalar: bigint },
    ];
    fee: bigint;
    relayer: string;
    noteCts: [Uint8Array, Uint8Array];
    mvkCts: [Uint8Array, Uint8Array];
    /** optional per-approver signing hook (default: sign from org.members[i]). */
    sign?: (memberIndex: number, message: bigint) => Promise<OrgSignature>;
  }): Promise<{
    spend: OrgSpendArg;
    outNotes: [Note, Note];
    nullifiers: [bigint, bigint];
    outCommitments: [bigint, bigint];
    spendMessage: bigint;
    proof: ProveResult;
    provingMs: number;
  }> {
    if (!this.circuits.joinsplitOrg) {
      throw new Error("transferOrg requires circuits.joinsplitOrg (the joinsplit_org artifacts)");
    }
    const { org } = opts;
    if (org.members.length > MAX_ORG_SIGNERS) {
      throw new Error(`org presents at most ${MAX_ORG_SIGNERS} candidate signers per spend (got ${org.members.length})`);
    }
    if (opts.signerIndices.length < Number(org.threshold)) {
      throw new Error(`need ≥ threshold (${org.threshold}) approvals, got ${opts.signerIndices.length}`);
    }
    if (opts.input.note.recipientPk !== org.recipientPk) {
      throw new Error("input note is not owned by this org (recipientPk mismatch)");
    }

    const assetId = await this.assetId();
    const root = this.poolTree.root();

    // Pad the candidate set to MAX_ORG_SIGNERS slots (unused slots reuse a real
    // member with enabled=0 — the circuit only verifies enabled slots).
    const cand = Array.from({ length: MAX_ORG_SIGNERS }, (_, i) =>
      i < org.members.length ? i : 0,
    );

    const outNotes = opts.outputs.map((o) => o.note) as [Note, Note];
    const outCommitments = outNotes.map(noteCommitment) as [bigint, bigint];
    const outTags = outNotes.map((n, i) =>
      mvkTag(opts.outputs[i].mvkPubScalar, n.blinding),
    ) as [bigint, bigint];

    // input0 = org note (M-of-N nullifier), input1 = genuine zero dummy.
    const orgBlinding = opts.input.note.blinding;
    const li0 = opts.input.leafIndex;
    const dSk = randomFieldElement();
    const dBl = randomFieldElement();
    const li1 = Number(randomFieldElement() % BigInt(2 ** 31));
    const n0 = orgNullifier(org.akGroup, orgBlinding, BigInt(li0));
    const n1 = noteNullifier(dSk, BigInt(li1));
    const nullifiers: [bigint, bigint] = [n0, n1];

    const orgPath = this.poolTree.path(li0);

    // authorized-MVK registry membership for each output's MVK.
    const mvkKeyMeta = DEFAULT_MVK_KEY_META;
    let mvkReg: MvkRegistryMirror;
    if (this.mvkRegistry) {
      mvkReg = this.mvkRegistry;
    } else {
      mvkReg = new MvkRegistryMirror();
      for (const o of opts.outputs) mvkReg.register(o.mvkPubScalar, mvkKeyMeta);
    }
    const mvkRegPaths = opts.outputs.map((o) => mvkReg.pathFor(o.mvkPubScalar));

    const extHash = await this.cli.view(this.dep.pool, this.viewSource, [
      "transfer_ext_hash",
      "--relayer", opts.relayer,
      "--fee", opts.fee.toString(),
      "--note_ct0", hexBytes(opts.noteCts[0]),
      "--note_ct1", hexBytes(opts.noteCts[1]),
      "--mvk_ct0", hexBytes(opts.mvkCts[0]),
      "--mvk_ct1", hexBytes(opts.mvkCts[1]),
    ]);

    // spend message = Poseidon(n0,n1,c0,c1) — collect approvals LAST.
    const spendMessage = await orgSpendMessage(n0, n1, outCommitments[0], outCommitments[1]);
    const getSig = async (slot: number): Promise<OrgSignature> => {
      const member = org.members[cand[slot]];
      return opts.sign ? opts.sign(cand[slot], spendMessage) : signOrgSpend(member, spendMessage);
    };
    // sign every candidate slot (unenabled slots' sigs are not verified, but
    // must be well-formed field elements); enabled = approver slots.
    const sigs: OrgSignature[] = [];
    for (let s = 0; s < MAX_ORG_SIGNERS; s++) sigs.push(await getSig(s));
    const enabled = cand.map((_, s) => (opts.signerIndices.includes(s) ? 1n : 0n));
    const candPaths = cand.map((mi) => org.memberPaths[mi]);

    const org0 = {
      enabled,
      Ax: cand.map((mi) => org.members[mi].Ax),
      Ay: cand.map((mi) => org.members[mi].Ay),
      S: sigs.map((g) => g.S),
      R8x: sigs.map((g) => g.R8x),
      R8y: sigs.map((g) => g.R8y),
      pathElements: candPaths.map((p) => p.pathElements),
      pathIndices: candPaths.map((p) => BigInt(p.pathIndices)),
    };
    const none = { ...org0, enabled: cand.map(() => 0n) };

    const witness = toWitnessInput({
      root,
      assetId,
      inputNullifier: nullifiers,
      outputCommitment: outCommitments,
      fee: opts.fee,
      extDataHash: BigInt(extHash as string),
      mvkTag: outTags,
      registeredMvkRoot: mvkReg.root(),
      mvkKeyMeta: opts.outputs.map(() => mvkKeyMeta),
      mvkPathElements: mvkRegPaths.map((p) => p.pathElements),
      mvkPathIndices: mvkRegPaths.map((p) => p.pathIndices),
      inAmount: [opts.input.note.amount, 0n],
      inOrgSpendId: [0n, dSk],
      inBlinding: [orgBlinding, dBl],
      inPathIndices: [BigInt(li0), BigInt(li1)],
      inPathElements: [orgPath.pathElements, new Array<bigint>(this.dep.treeLevels).fill(0n)],
      outAmount: outNotes.map((n) => n.amount),
      outPubkey: outNotes.map((n) => n.recipientPk),
      outBlinding: outNotes.map((n) => n.blinding),
      outMvkPub: opts.outputs.map((o) => o.mvkPubScalar),
      // org dual-control witness (input0 = org, input1 = dummy)
      inIsOrg: [1n, 0n],
      orgMemberRoot: [org.memberRoot, org.memberRoot],
      orgThreshold: [org.threshold, 0n],
      akGroup: [org.akGroup, 0n],
      mEnabled: [org0.enabled, none.enabled],
      mAx: [org0.Ax, none.Ax],
      mAy: [org0.Ay, none.Ay],
      mS: [org0.S, none.S],
      mR8x: [org0.R8x, none.R8x],
      mR8y: [org0.R8y, none.R8y],
      mPathElements: [org0.pathElements, none.pathElements],
      mPathIndices: [org0.pathIndices, none.pathIndices],
    });

    const _pt = Date.now();
    const proof = await this.prover.prove(this.circuits.joinsplitOrg, witness);
    const provingMs = Date.now() - _pt;

    const spend: OrgSpendArg = {
      root: root.toString(),
      nullifier0: n0.toString(),
      nullifier1: n1.toString(),
      outCommitment0: outCommitments[0].toString(),
      outCommitment1: outCommitments[1].toString(),
      fee: opts.fee.toString(),
      relayer: opts.relayer,
      mvkTag0: outTags[0].toString(),
      mvkTag1: outTags[1].toString(),
      noteCt0: hexBytes(opts.noteCts[0]),
      noteCt1: hexBytes(opts.noteCts[1]),
      mvkCt0: hexBytes(opts.mvkCts[0]),
      mvkCt1: hexBytes(opts.mvkCts[1]),
      registeredMvkRoot: mvkReg.root().toString(),
      proof: proof.sorobanProof,
    };
    return { spend, outNotes, nullifiers, outCommitments, spendMessage, proof, provingMs };
  }

  /**
   * Single org join-split (M-of-N dual control) — settles under the JSPLITORG VK.
   * Thin wrapper over `buildOrgSpend` + a `transfer_org` submit (unchanged shape).
   */
  async transferOrg(opts: {
    source: string;
    org: OrgIdentity;
    signerIndices: number[];
    input: { note: Note; leafIndex: number };
    outputs: [
      { note: Note; mvkPubScalar: bigint },
      { note: Note; mvkPubScalar: bigint },
    ];
    fee: bigint;
    relayer: string;
    noteCts: [Uint8Array, Uint8Array];
    mvkCts: [Uint8Array, Uint8Array];
    sign?: (memberIndex: number, message: bigint) => Promise<OrgSignature>;
  }): Promise<{
    txHash?: string;
    outNotes: [Note, Note];
    nullifiers: [bigint, bigint];
    outCommitments: [bigint, bigint];
    outLeafIndices: [number, number];
    spendMessage: bigint;
    proof: ProveResult;
    provingMs: number;
  }> {
    const b = await this.buildOrgSpend(opts);
    const fnArgs = transferRelayFnArgs({
      submitter: await this.cli.keyAddress(opts.source),
      root: b.spend.root,
      nullifier0: b.spend.nullifier0,
      nullifier1: b.spend.nullifier1,
      outCommitment0: b.spend.outCommitment0,
      outCommitment1: b.spend.outCommitment1,
      fee: b.spend.fee,
      relayerAddress: b.spend.relayer,
      mvkTag0: b.spend.mvkTag0,
      mvkTag1: b.spend.mvkTag1,
      noteCt0: b.spend.noteCt0,
      noteCt1: b.spend.noteCt1,
      mvkCt0: b.spend.mvkCt0,
      mvkCt1: b.spend.mvkCt1,
      registeredMvkRoot: b.spend.registeredMvkRoot,
      proof: JSON.stringify(b.spend.proof),
    });
    fnArgs[0] = "transfer_org"; // same arg shape; settles under the JSPLITORG VK
    const res = await this.cli.invoke({ contractId: this.dep.pool, source: opts.source, send: true, fnArgs });
    const i0 = this.poolTree.insert(b.outCommitments[0]);
    const i1 = this.poolTree.insert(b.outCommitments[1]);
    await this.assertSynced();
    return {
      txHash: res.txHash,
      outNotes: b.outNotes,
      nullifiers: b.nullifiers,
      outCommitments: b.outCommitments,
      outLeafIndices: [i0, i1],
      spendMessage: b.spendMessage,
      proof: b.proof,
      provingMs: b.provingMs,
    };
  }

  /**
   * Batched org join-split: settle N independent org spends with ONE combined
   * verification via `pool.batch_transfer_org`. Each `spends[i]` is built like a
   * `transferOrg` (its own input note + 2 outputs), all against the SAME pre-batch
   * root; the contract verifies them with one combined BN254 pairing check and
   * applies all 2N nullifiers/commitments in one tx. HONEST: this is batched
   * VERIFICATION (cost still linear in N); cap N at the measured per-tx limit and
   * chunk larger runs. Returns one txHash + per-spend bookkeeping.
   */
  async batchTransferOrg(opts: {
    source: string;
    spends: Array<{
      org: OrgIdentity;
      signerIndices: number[];
      input: { note: Note; leafIndex: number };
      outputs: [
        { note: Note; mvkPubScalar: bigint },
        { note: Note; mvkPubScalar: bigint },
      ];
      fee: bigint;
      relayer: string;
      noteCts: [Uint8Array, Uint8Array];
      mvkCts: [Uint8Array, Uint8Array];
      sign?: (memberIndex: number, message: bigint) => Promise<OrgSignature>;
    }>;
    /** if true, simulate only (validate encoding + cost) and do not submit. */
    simulateOnly?: boolean;
  }): Promise<{
    txHash?: string;
    spends: Array<{
      outNotes: [Note, Note];
      nullifiers: [bigint, bigint];
      outCommitments: [bigint, bigint];
      outLeafIndices: [number, number];
      provingMs: number;
    }>;
  }> {
    if (opts.spends.length === 0) throw new Error("batchTransferOrg: empty batch");
    const submitter = await this.cli.keyAddress(opts.source);
    // Build every spend BEFORE inserting any output, so all proofs bind the same
    // pre-batch root (each input note is already on-chain; outputs aren't yet).
    const built = [];
    for (const s of opts.spends) built.push(await this.buildOrgSpend({ source: opts.source, ...s }));

    const spendsJson = built.map((b) => ({
      root: b.spend.root,
      nullifier0: b.spend.nullifier0,
      nullifier1: b.spend.nullifier1,
      out_commitment0: b.spend.outCommitment0,
      out_commitment1: b.spend.outCommitment1,
      fee: b.spend.fee,
      relayer: b.spend.relayer,
      mvk_tag0: b.spend.mvkTag0,
      mvk_tag1: b.spend.mvkTag1,
      note_ct0: b.spend.noteCt0,
      note_ct1: b.spend.noteCt1,
      mvk_ct0: b.spend.mvkCt0,
      mvk_ct1: b.spend.mvkCt1,
      registered_mvk_root: b.spend.registeredMvkRoot,
      proof: b.spend.proof,
    }));
    const fnArgs = ["batch_transfer_org", "--submitter", submitter, "--spends", JSON.stringify(spendsJson)];
    const res = await this.cli.invoke({
      contractId: this.dep.pool,
      source: opts.source,
      send: !opts.simulateOnly,
      fnArgs,
    });

    const out = built.map((b) => {
      const i0 = this.poolTree.insert(b.outCommitments[0]);
      const i1 = this.poolTree.insert(b.outCommitments[1]);
      return {
        outNotes: b.outNotes,
        nullifiers: b.nullifiers,
        outCommitments: b.outCommitments,
        outLeafIndices: [i0, i1] as [number, number],
        provingMs: b.provingMs,
      };
    });
    await this.assertSynced();
    return { txHash: res.txHash, spends: out };
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

    // Authorized-MVK registry membership of the change note's MVK (closes the
    // audit P0 — see shield). Shared synced registry (if set) → on-chain-known
    // root; otherwise a single-leaf stand-in over the change MVK.
    const mvkKeyMeta = DEFAULT_MVK_KEY_META;
    const mvkReg = this.mvkRegistry ?? MvkRegistryMirror.singleLeaf(opts.changeMvkPubScalar, mvkKeyMeta);
    const mvkPathReg = mvkReg.pathFor(opts.changeMvkPubScalar);

    const witness = toWitnessInput({
      root,
      assetId,
      nullifier,
      publicAmount: opts.amount,
      changeCommitment,
      extDataHash: BigInt(extHash as string),
      aspNonMembershipRoot: denyRoot,
      changeMvkTag: changeTag,
      registeredMvkRoot: mvkReg.root(),
      inAmount: opts.input.note.amount,
      inOrgSpendId: opts.input.spendSk,
      inBlinding: opts.input.note.blinding,
      inPathIndices: path.pathIndices,
      inPathElements: path.pathElements,
      changeAmount,
      changePubkey: changeNote.recipientPk,
      changeBlinding: changeNote.blinding,
      changeMvkPub: opts.changeMvkPubScalar,
      mvkKeyMeta,
      mvkPathElements: mvkPathReg.pathElements,
      mvkPathIndices: mvkPathReg.pathIndices,
      smtSiblings: siblings,
      smtOldKey: BigInt(fr.not_found_key),
      smtOldValue: BigInt(fr.not_found_value),
      smtIsOld0: fr.is_old0 ? 1n : 0n,
    });
    const _pw = Date.now();
    const proof = await this.prover.prove(this.circuits.unshield, witness);
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
        "--registered_mvk_root", mvkReg.root().toString(),
        "--proof", JSON.stringify(proof.sorobanProof),
      ],
    });
    this.poolTree.insert(changeCommitment);
    await this.assertSynced();
    return { txHash: res.txHash, nullifier, changeNote, changeCommitment, proof, provingMs };
  }
}
