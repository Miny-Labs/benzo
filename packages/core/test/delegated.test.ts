/**
 * DelegatedProver test — verifies the remote-prover RPC: the witness is POSTed
 * to the configured endpoint and the returned ProveResult is surfaced; a non-OK
 * response throws. (The witness-hiding transport is a mainnet concern; this MVP
 * is a trusted delegate.)
 */
import { describe, it, expect } from "vitest";
import { DelegatedProver } from "../src/prover.js";

const canned = {
  proof: {} as never,
  publicSignals: ["7"],
  sorobanProof: { a: "0xa", b: "0xb", c: "0xc" },
  sorobanPublics: ["0x7"],
};

describe("DelegatedProver", () => {
  it("POSTs the witness to the remote prover and returns its ProveResult", async () => {
    let sent: { circuit?: string; input?: unknown } = {};
    const fakeFetch = (async (_url: string, opts: { body: string }) => {
      sent = JSON.parse(opts.body);
      return { ok: true, json: async () => canned };
    }) as unknown as typeof fetch;

    // allowClearWitness=true: explicitly accept the cleartext-witness trust model.
    const prover = new DelegatedProver("https://prover.example/prove", fakeFetch, true);
    const res = await prover.prove({ wasmPath: "", zkeyPath: "", circuit: "joinsplit" }, { x: "1" });

    expect(res.publicSignals).toEqual(["7"]);
    expect(sent.circuit).toBe("joinsplit");
    expect(sent.input).toEqual({ x: "1" });
  });

  it("throws on a non-OK response", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const prover = new DelegatedProver("https://prover.example/prove", fakeFetch, true);
    await expect(prover.prove({ wasmPath: "", zkeyPath: "" }, {})).rejects.toThrow("HTTP 503");
  });

  it("REFUSES to send the witness in clear unless explicitly opted in", async () => {
    const prover = new DelegatedProver("https://prover.example/prove");
    await expect(prover.prove({ wasmPath: "", zkeyPath: "", circuit: "joinsplit" }, { x: "1" })).rejects.toThrow(/CLEAR/i);
  });
});
