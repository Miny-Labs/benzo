import { describe, expect, it } from "vitest";
import { BenzoClient } from "../src/client.js";
import { noteCommitment, noteNullifier } from "../src/notes.js";
import { encodeNotePlain, seal, type NotePlain } from "../src/viewkeys.js";
import type { CircuitSet, BenzoDeployment } from "../src/pool.js";
import type { ProveResult, ProverPort } from "../src/prover.js";
import type { ChainClient } from "../src/stellar.js";

const deployment: BenzoDeployment = {
  pool: "pool",
  verifier: "verifier",
  merkle: "merkle",
  nullifierSet: "nullifier",
  aspMembership: "asp",
  aspNonMembership: "asp-non",
  viewkeyAnchor: "viewkey",
  token: "token",
  treeLevels: 32,
  aspLevels: 16,
  smtLevels: 16,
};

const artifacts = { wasmPath: "unused.wasm", zkeyPath: "unused.zkey" };
const circuits: CircuitSet = { shield: artifacts, joinsplit: artifacts, unshield: artifacts };

const cli: ChainClient = {
  async invoke() {
    throw new Error("not used");
  },
  async view() {
    throw new Error("not used");
  },
  async keyAddress() {
    throw new Error("not used");
  },
};

const prover: ProverPort = {
  name: "test",
  async prove(): Promise<ProveResult> {
    throw new Error("not used");
  },
};

function makeClient(): BenzoClient {
  const client = new BenzoClient({
    cli,
    deployment,
    circuits,
    prover,
    rpcUrl: "http://unused",
    txSource: "unused",
  });
  client.createAccount("alice");
  return client;
}

function addScannedNote(client: BenzoClient, opts: { amount: bigint; leafIndex: number; txHash: string; ts?: number }): void {
  const plain: NotePlain = {
    amount: opts.amount,
    recipientPk: client.account.spendPub,
    blinding: 99n + BigInt(opts.leafIndex),
    assetId: 7n,
    memo: "private payment",
  };
  client.scanner.commitments[opts.leafIndex] = {
    leafIndex: opts.leafIndex,
    commitment: noteCommitment(plain),
    ciphertext: seal(encodeNotePlain(plain), client.account.viewPub).bytes,
    mvkTag: client.account.mvkScalar,
    ledger: 100 + opts.leafIndex,
    ts: opts.ts ?? 1_800_000_000 + opts.leafIndex,
    txHash: opts.txHash,
  };
}

describe("BenzoClient.getHistory", () => {
  it("does not surface zero-amount scanned notes as user-visible receives", () => {
    const client = makeClient();
    addScannedNote(client, { amount: 0n, leafIndex: 0, txHash: "tx_zero" });

    expect(client.getHistory()).toEqual([]);
  });

  it("keeps positive incoming scanned notes visible", () => {
    const client = makeClient();
    addScannedNote(client, { amount: 2_000_000n, leafIndex: 0, txHash: "tx_positive" });

    expect(client.getHistory()).toMatchObject([
      {
        type: "receive",
        amount: "2000000",
        counterparty: "shielded",
        status: "settled",
        txHash: "tx_positive",
        memo: "private payment",
      },
    ]);
  });

  it("does not show same-transaction self-change notes as incoming payments", () => {
    const client = makeClient();
    addScannedNote(client, { amount: 5_000_000n, leafIndex: 0, txHash: "tx_incoming" });
    addScannedNote(client, { amount: 3_000_000n, leafIndex: 1, txHash: "tx_change" });

    const spent = noteNullifier(client.account.spendSk, 0n);
    client.scanner.nullifiers.add(spent.toString());
    client.scanner.nullifierRecords.set(spent.toString(), {
      nullifier: spent,
      ledger: 120,
      ts: 1_800_000_120,
      txHash: "tx_change",
    });

    expect(client.getHistory().map((h) => [h.txHash, h.amount])).toEqual([["tx_incoming", "5000000"]]);
  });
});
