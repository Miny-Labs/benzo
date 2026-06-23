/**
 * Network configuration — 12-factor (env-driven) so a build targets testnet OR
 * mainnet WITHOUT any code change. Testnet defaults keep dev/CI zero-config; a
 * mainnet build sets the VITE_BENZO_* vars (RPC, passphrase, deployment JSON,
 * operator addresses). This removes the "hardcoded testnet" smell — going to
 * production is an env swap + funded operators + a registered mainnet deployment.
 *
 * Everything here is PUBLIC: RPC URLs, contract IDs, and a funded G-address used
 * only as a read/simulation footprint source. No secret material is ever client-side.
 */
// Single source of truth: the live testnet deployment, imported (and inlined at
// build) straight from deployments/testnet.json. This makes the wallet's contract
// IDs PHYSICALLY UNABLE to drift from what is actually deployed — the prior
// hardcoded block had gone stale against a dead pre-redeploy cluster. A mainnet
// build overrides via VITE_BENZO_DEPLOYMENT (deployments/mainnet.json). The drift
// guard in network.drift.test.ts asserts this equality so a future re-hardcode fails CI.
import testnetDeployment from "../../../../deployments/testnet.json";

const env = import.meta.env as unknown as Record<string, string | undefined>;

export const NETWORK = env.VITE_BENZO_NETWORK ?? "testnet";
export const RPC_URL = env.VITE_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

/** Human label for the active network — never hardcode "testnet" on a money screen. */
export const NETWORK_LABEL = NETWORK === "public" || NETWORK === "pubnet" ? "Stellar" : "Stellar Testnet";

/** Testnet deployment — derived from deployments/testnet.json (the zero-config
 *  default), so these IDs are exactly what is live on-chain and cannot go stale. */
const TESTNET_DEPLOYMENT = {
  pool: testnetDeployment.pool,
  verifier: testnetDeployment.verifier,
  merkle: testnetDeployment.merkle,
  nullifierSet: testnetDeployment.nullifierSet,
  aspMembership: testnetDeployment.aspMembership,
  aspNonMembership: testnetDeployment.aspNonMembership,
  viewkeyAnchor: testnetDeployment.viewkeyAnchor,
  mvkRegistry: testnetDeployment.mvkRegistry,
  handleRegistry: testnetDeployment.handleRegistry,
  token: testnetDeployment.token,
  treeLevels: testnetDeployment.treeLevels,
  aspLevels: testnetDeployment.aspLevels,
  smtLevels: testnetDeployment.smtLevels,
};

/** Deployment coordinates. A mainnet build sets VITE_BENZO_DEPLOYMENT (the JSON
 *  of deployments/mainnet.json); otherwise the testnet defaults apply. */
export const DEPLOYMENT: typeof TESTNET_DEPLOYMENT = env.VITE_BENZO_DEPLOYMENT
  ? { ...TESTNET_DEPLOYMENT, ...(JSON.parse(env.VITE_BENZO_DEPLOYMENT) as Partial<typeof TESTNET_DEPLOYMENT>) }
  : TESTNET_DEPLOYMENT;

export const VERIFIER_ID = DEPLOYMENT.verifier;

/** Funded G-address used only as a read/simulation footprint source (never signs). */
export const SIM_SOURCE = env.VITE_BENZO_SIM_SOURCE ?? "GBRMUZELYDNXSBYF5KOLLSV4XLQYNZJQNLXQ3HTFCWNRIBS3I6EUBCMP";

/** The gas relay's operator G-address (its own funded key, separate from any other). */
export const RELAYER_ADDRESS = env.VITE_BENZO_RELAYER_ADDRESS ?? "GD2U26BTLNEKRLM7AMXPO5T64I7SPRPUF26T44RHSJBLFI5YGRKLZMT7";
