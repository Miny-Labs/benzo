/**
 * Shared helper to construct the UI-facing BenzoClient facade against the
 * live testnet deployment. Used by the facade demo scripts (items A–E).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BenzoClient, StellarCli, configFromEnv } from "@benzo/sdk";
import { AnchorClient, anchorConfigFromEnv } from "@benzo/anchor";

const repo = fileURLToPath(new URL("../..", import.meta.url));

export function loadDeployment() {
  return JSON.parse(readFileSync(`${repo}/deployments/testnet.json`, "utf8"));
}

export const explorer = (tx) => `https://stellar.expert/explorer/testnet/tx/${tx}`;

export function circuitSet() {
  return Object.fromEntries(
    ["shield", "joinsplit", "unshield"].map((c) => [
      c,
      {
        wasmPath: `${repo}/circuits/build/${c}/${c}_js/${c}.wasm`,
        zkeyPath: `${repo}/circuits/build/${c}/${c}.zkey`,
      },
    ]),
  );
}

/**
 * Build a BenzoClient facade. `withAnchor` wires the self-hosted anchor for
 * cashIn/cashOut; the caller is responsible for starting the anchor server.
 */
export function makeFacade({ withAnchor = false, withRelayer = false } = {}) {
  const dep = loadDeployment();
  const cli = new StellarCli(configFromEnv());
  const client = new BenzoClient({
    cli,
    deployment: {
      pool: dep.pool,
      verifier: dep.verifier,
      merkle: dep.merkle,
      nullifierSet: dep.nullifierSet,
      aspMembership: dep.aspMembership,
      aspNonMembership: dep.aspNonMembership,
      viewkeyAnchor: dep.viewkeyAnchor,
      token: dep.token,
      treeLevels: dep.treeLevels,
      aspLevels: dep.aspLevels,
      smtLevels: dep.smtLevels,
    },
    circuits: circuitSet(),
    rpcUrl: process.env.SOROBAN_RPC_URL,
    txSource: "benzo-deployer",
    relayer: withRelayer
      ? { source: "benzo-relayer", address: process.env.RELAYER_PUBLIC }
      : undefined,
    anchor: withAnchor ? new AnchorClient(anchorConfigFromEnv()) : undefined,
  });
  return { dep, cli, client };
}

export async function usdcBalance(account) {
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${account}`);
  if (!res.ok) return "0";
  const body = await res.json();
  const line = body.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === process.env.USDC_ISSUER,
  );
  return line ? line.balance : "0";
}

export async function liveNextIndex(cli, dep) {
  const v = await cli.view(dep.merkle, "benzo-deployer", ["next_index"]);
  return Number(v);
}
