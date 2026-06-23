import { describe, it, expect } from "vitest";
import { DEPLOYMENT, VERIFIER_ID } from "./network";
import testnet from "../../../../deployments/testnet.json";

// Drift guard: the wallet transacts CLIENT-SIDE against these contract IDs, so if
// they ever fall out of sync with the actually-deployed cluster the browser signs
// against dead contracts (exactly the bug this replaced). network.ts now derives
// the deployment FROM deployments/testnet.json, so this holds by construction; the
// test fails CI loudly if anyone re-hardcodes the IDs out of sync with the file.

describe("wallet deployment drift guard", () => {
  it("wallet contract IDs equal the live deployments/testnet.json", () => {
    expect(DEPLOYMENT.verifier).toBe(testnet.verifier);
    expect(DEPLOYMENT.pool).toBe(testnet.pool);
    expect(DEPLOYMENT.merkle).toBe(testnet.merkle);
    expect(DEPLOYMENT.nullifierSet).toBe(testnet.nullifierSet);
    expect(DEPLOYMENT.aspMembership).toBe(testnet.aspMembership);
    expect(DEPLOYMENT.token).toBe(testnet.token);
    expect(VERIFIER_ID).toBe(testnet.verifier);
  });
});
