import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, parseEther } from "viem";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const infraDir = join(scriptDir, "..");

const ADMIN = "0x0e68879016b83F76D279aFAeFB1B64C066823AdC";
const DEPLOYER = "0x3cdff5fDfe43401BDE629faB735B4C9E29bB12Eb";
const OPS = "0x13b8d12414dd468a9eCbA24d0a162C17affd6D32";
const DRIPPER = "0xf1ED91B084e0F9EeE5798E9FA8BC40295479836c";
const BACKEND = "0xa0C5455eF9A7D71e9B5b3ce8Cf3C7E06D856bEDB";
const GENESIS_TIMESTAMP = 1_783_296_000;

const expectedFeeConfig = {
  gasLimit: 20_000_000,
  targetBlockRate: 2,
  minBaseFee: 1_000_000_000,
  targetGas: 15_000_000,
  baseFeeChangeDenominator: 36,
  minBlockGasCost: 0,
  maxBlockGasCost: 1_000_000,
  blockGasCostStep: 200_000,
};

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function objectAt(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${key} must be an object`);
  return value as JsonObject;
}

function stringArrayAt(source: JsonObject, key: string): string[] {
  const value = source[key];
  assert(Array.isArray(value), `${key} must be an array`);
  for (const entry of value) {
    assert(typeof entry === "string", `${key} entries must be strings`);
  }
  return value;
}

function sameAddress(actual: string, expected: string): boolean {
  return getAddress(actual) === getAddress(expected);
}

function expectAddressList(actual: string[], expected: string[], label: string) {
  assert(actual.length === expected.length, `${label} length mismatch`);
  for (const [index, address] of actual.entries()) {
    assert(sameAddress(address, expected[index] ?? ""), `${label}[${index}] mismatch`);
  }
}

function expectNoOverlap(config: JsonObject, label: string) {
  const seen = new Set<string>();
  for (const key of ["adminAddresses", "managerAddresses", "enabledAddresses"]) {
    const addresses = key in config ? stringArrayAt(config, key) : [];
    for (const address of addresses) {
      const checksummed = getAddress(address);
      assert(!seen.has(checksummed), `${label} has overlapping role for ${checksummed}`);
      seen.add(checksummed);
    }
  }
}

function expectAlloc(alloc: JsonObject, address: string, amount: bigint) {
  const entry = objectAt(alloc, address);
  const balance = entry.balance;
  assert(typeof balance === "string", `alloc ${address} balance must be a string`);
  assert(BigInt(balance) === amount, `alloc ${address} balance mismatch`);
}

const genesis = readJson(join(infraDir, "genesis", "benzonet.genesis.json"));
const benzonet = readJson(join(infraDir, "benzonet.json"));
const config = objectAt(genesis, "config");
const alloc = objectAt(genesis, "alloc");

assert(config.chainId === 68_420, "chainId must be 68420");
assert(benzonet.chainId === 68_420, "benzonet metadata chainId must be 68420");
assert(config.subnetEVMTimestamp === GENESIS_TIMESTAMP, "subnetEVMTimestamp mismatch");
assert(config.durangoTimestamp === GENESIS_TIMESTAMP, "durangoTimestamp mismatch");
assert(config.etnaTimestamp === GENESIS_TIMESTAMP, "etnaTimestamp mismatch");
assert(config.fortunaTimestamp === GENESIS_TIMESTAMP, "fortunaTimestamp mismatch");
assert(config.graniteTimestamp === GENESIS_TIMESTAMP, "graniteTimestamp mismatch");
assert(genesis.timestamp === "0x6a4af000", "genesis timestamp mismatch");
assert(genesis.gasLimit === "0x1312d00", "genesis gasLimit mismatch");
assert(genesis.baseFeePerGas === "0x3b9aca00", "genesis baseFeePerGas mismatch");

const feeConfig = objectAt(config, "feeConfig");
for (const [key, value] of Object.entries(expectedFeeConfig)) {
  assert(feeConfig[key] === value, `feeConfig.${key} mismatch`);
}

const txAllowList = objectAt(config, "txAllowListConfig");
expectAddressList(stringArrayAt(txAllowList, "adminAddresses"), [ADMIN], "txAllowList.adminAddresses");
expectAddressList(stringArrayAt(txAllowList, "managerAddresses"), [OPS], "txAllowList.managerAddresses");
expectAddressList(stringArrayAt(txAllowList, "enabledAddresses"), [DEPLOYER, DRIPPER, BACKEND], "txAllowList.enabledAddresses");
assert(txAllowList.blockTimestamp === GENESIS_TIMESTAMP, "txAllowList blockTimestamp mismatch");
expectNoOverlap(txAllowList, "txAllowList");

const deployerAllowList = objectAt(config, "contractDeployerAllowListConfig");
expectAddressList(stringArrayAt(deployerAllowList, "adminAddresses"), [ADMIN], "contractDeployer.adminAddresses");
expectAddressList(stringArrayAt(deployerAllowList, "enabledAddresses"), [DEPLOYER], "contractDeployer.enabledAddresses");
assert(deployerAllowList.blockTimestamp === GENESIS_TIMESTAMP, "contractDeployer blockTimestamp mismatch");
expectNoOverlap(deployerAllowList, "contractDeployer");

const nativeMinter = objectAt(config, "contractNativeMinterConfig");
expectAddressList(stringArrayAt(nativeMinter, "adminAddresses"), [ADMIN], "nativeMinter.adminAddresses");
expectAddressList(stringArrayAt(nativeMinter, "enabledAddresses"), [DRIPPER], "nativeMinter.enabledAddresses");
assert(nativeMinter.blockTimestamp === GENESIS_TIMESTAMP, "nativeMinter blockTimestamp mismatch");
expectNoOverlap(nativeMinter, "nativeMinter");

const feeManager = objectAt(config, "feeManagerConfig");
expectAddressList(stringArrayAt(feeManager, "adminAddresses"), [ADMIN], "feeManager.adminAddresses");
assert(feeManager.blockTimestamp === GENESIS_TIMESTAMP, "feeManager blockTimestamp mismatch");
expectNoOverlap(feeManager, "feeManager");

expectAlloc(alloc, ADMIN, parseEther("1000000"));
expectAlloc(alloc, DEPLOYER, parseEther("100000"));
expectAlloc(alloc, OPS, parseEther("100000"));
expectAlloc(alloc, DRIPPER, parseEther("100000"));
expectAlloc(alloc, BACKEND, parseEther("100000"));

// Sovereign-L1 (ACP-77) requirements, learned by deploying to Fuji:
// the PoA validator manager lives at the fixed vanity address 0x0feedc0de… and
// MUST be a genesis predeploy (you can't deploy code to a chosen address), and
// it reads the P-Chain conversion via a WARP message — so warpConfig must be
// present and cannot activate before Durango (blockTimestamp >= durangoTimestamp).
const managerProxyKey = Object.keys(alloc).find((key) =>
  key.toLowerCase().replace(/^0x/, "").startsWith("0feedc0de"),
);
assert(
  managerProxyKey !== undefined,
  "validator manager proxy predeploy (0x0feedc0de…) is missing from alloc",
);
const managerProxy = objectAt(alloc, managerProxyKey);
assert(
  typeof managerProxy.code === "string" && managerProxy.code.length > 2,
  "validator manager proxy must carry predeployed bytecode",
);

const warp = objectAt(config, "warpConfig");
assert(
  warp.blockTimestamp === GENESIS_TIMESTAMP,
  "warpConfig.blockTimestamp must equal the genesis/Durango timestamp",
);
assert(
  warp.quorumNumerator === 67,
  "warpConfig.quorumNumerator must be 67 (the avalanche-cli PoA default)",
);
assert(
  warp.requirePrimaryNetworkSigners === true,
  "warpConfig.requirePrimaryNetworkSigners must be true for a sovereign L1",
);

console.log("BenzoNet genesis metadata is internally consistent.");
