import { describe, expect, it, vi } from "vitest";
import { BenzoClient } from "../src/client.js";
import type { BenzoDeployment, CircuitSet } from "../src/pool.js";
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

const prover: ProverPort = {
  name: "test",
  async prove(): Promise<ProveResult> {
    throw new Error("not used");
  },
};

function makeClient(viewResult: unknown): BenzoClient {
  const cli: ChainClient = {
    invoke: vi.fn(async () => ({ result: null, raw: "" })),
    view: vi.fn(async () => viewResult),
    keyAddress: vi.fn(async () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
  };
  return new BenzoClient({
    cli,
    deployment,
    circuits,
    prover,
    rpcUrl: "http://unused",
    txSource: "unused",
    requestRegistry: "request-registry",
  });
}

describe("BenzoClient request registry reads", () => {
  it("decodes unit enum status variants returned by SDK simulate reads", async () => {
    const client = makeClient({
      amount: "11100000",
      min_amount: "0",
      paid_total: "0",
      expiry: 1783284399,
      status: ["Cancelled"],
    });

    await expect(client.getRequest("151444")).resolves.toMatchObject({
      status: "Cancelled",
      amount: 11100000n,
      minAmount: 0n,
      paidTotal: 0n,
      expiry: 1783284399,
    });
  });
});
