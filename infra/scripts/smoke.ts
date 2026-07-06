import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 68_420;
const MIN_BASE_FEE = 1_000_000_000n;
const MINT_AMOUNT = parseEther("0.01");

const ROLES = {
  none: 0n,
  enabled: 1n,
  admin: 2n,
  manager: 3n,
} as const;

const ADDRESSES = {
  admin: getAddress("0x0e68879016b83F76D279aFAeFB1B64C066823AdC"),
  deployer: getAddress("0x3cdff5fDfe43401BDE629faB735B4C9E29bB12Eb"),
  ops: getAddress("0x13b8d12414dd468a9eCbA24d0a162C17affd6D32"),
  dripper: getAddress("0xf1ED91B084e0F9EeE5798E9FA8BC40295479836c"),
  backend: getAddress("0xa0C5455eF9A7D71e9B5b3ce8Cf3C7E06D856bEDB"),
} as const;

const PRECOMPILES = {
  contractDeployerAllowList: getAddress("0x0200000000000000000000000000000000000000"),
  contractNativeMinter: getAddress("0x0200000000000000000000000000000000000001"),
  txAllowList: getAddress("0x0200000000000000000000000000000000000002"),
  feeManager: getAddress("0x0200000000000000000000000000000000000003"),
} as const;

const FEE_CONFIG_ARGS = [
  20_000_000n,
  2n,
  MIN_BASE_FEE,
  15_000_000n,
  36n,
  0n,
  1_000_000n,
  200_000n,
] as const;

const ALLOW_LIST_ABI = [
  {
    type: "function",
    name: "readAllowList",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "role", type: "uint256" }],
  },
] as const satisfies Abi;

const NATIVE_MINTER_ABI = [
  {
    type: "function",
    name: "mintNativeCoin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "addr", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  ...ALLOW_LIST_ABI,
] as const satisfies Abi;

const FEE_MANAGER_ABI = [
  {
    type: "function",
    name: "setFeeConfig",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gasLimit", type: "uint256" },
      { name: "targetBlockRate", type: "uint256" },
      { name: "minBaseFee", type: "uint256" },
      { name: "targetGas", type: "uint256" },
      { name: "baseFeeChangeDenominator", type: "uint256" },
      { name: "minBlockGasCost", type: "uint256" },
      { name: "maxBlockGasCost", type: "uint256" },
      { name: "blockGasCostStep", type: "uint256" },
    ],
    outputs: [],
  },
  ...ALLOW_LIST_ABI,
] as const satisfies Abi;

const EMPTY_RUNTIME_DEPLOY_BYTECODE =
  "0x600a600c600039600a6000f3602a60005260206000f3" as const satisfies Hex;

const rpcUrl = process.env.BENZONET_RPC_URL ?? process.env.RPC_URL;
if (!rpcUrl) {
  throw new Error("Set BENZONET_RPC_URL or RPC_URL to the BenzoNet RPC endpoint.");
}

const benzoNet = defineChain({
  id: CHAIN_ID,
  name: "BenzoNet",
  nativeCurrency: {
    name: "Benzo Gas",
    symbol: "BGAS",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [rpcUrl],
    },
  },
});

const publicClient = createPublicClient({
  chain: benzoNet,
  transport: http(rpcUrl),
});

const walletClient = createWalletClient({
  chain: benzoNet,
  transport: http(rpcUrl),
});

function requirePrivateKey(envName: string): Hex {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Set ${envName}.`);
  }
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${envName} must be a 32-byte hex private key.`);
  }
  return normalized as Hex;
}

function accountFromEnv(envName: string, expectedAddress: Address): PrivateKeyAccount {
  const account = privateKeyToAccount(requirePrivateKey(envName));
  if (getAddress(account.address) !== expectedAddress) {
    throw new Error(`${envName} derives ${account.address}, expected ${expectedAddress}.`);
  }
  return account;
}

async function readRole(precompile: Address, address: Address): Promise<bigint> {
  return publicClient.readContract({
    address: precompile,
    abi: ALLOW_LIST_ABI,
    functionName: "readAllowList",
    args: [address],
  });
}

async function expectRole(label: string, precompile: Address, address: Address, expected: bigint) {
  const actual = await readRole(precompile, address);
  if (actual !== expected) {
    throw new Error(`${label} role mismatch for ${address}: expected ${expected}, got ${actual}.`);
  }
  console.log(`ok: ${label} role for ${address} = ${actual}`);
}

async function expectRejected(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`ok: ${label} rejected (${message.split("\n")[0]})`);
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function waitForTransaction(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${hash} failed with status ${receipt.status}.`);
  }
  return receipt;
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Connected RPC reports chainId ${chainId}, expected ${CHAIN_ID}.`);
  }
  console.log(`Connected to BenzoNet RPC ${rpcUrl}`);

  const deployer = accountFromEnv("BENZO_DEPLOYER_PRIVATE_KEY", ADDRESSES.deployer);
  const dripper = accountFromEnv("BENZO_DRIPPER_PRIVATE_KEY", ADDRESSES.dripper);
  const backend = accountFromEnv("BENZO_BACKEND_PRIVATE_KEY", ADDRESSES.backend);
  const unlisted = privateKeyToAccount(requirePrivateKey("BENZO_UNLISTED_PRIVATE_KEY"));

  if (Object.values(ADDRESSES).includes(getAddress(unlisted.address))) {
    throw new Error("BENZO_UNLISTED_PRIVATE_KEY must not derive a genesis role address.");
  }

  await expectRole("TxAllowList admin", PRECOMPILES.txAllowList, ADDRESSES.admin, ROLES.admin);
  await expectRole("TxAllowList manager", PRECOMPILES.txAllowList, ADDRESSES.ops, ROLES.manager);
  await expectRole("TxAllowList deployer", PRECOMPILES.txAllowList, ADDRESSES.deployer, ROLES.enabled);
  await expectRole("TxAllowList dripper", PRECOMPILES.txAllowList, ADDRESSES.dripper, ROLES.enabled);
  await expectRole("TxAllowList backend", PRECOMPILES.txAllowList, ADDRESSES.backend, ROLES.enabled);
  await expectRole("TxAllowList unlisted", PRECOMPILES.txAllowList, unlisted.address, ROLES.none);
  await expectRole(
    "ContractDeployerAllowList deployer",
    PRECOMPILES.contractDeployerAllowList,
    ADDRESSES.deployer,
    ROLES.enabled,
  );
  await expectRole(
    "ContractDeployerAllowList backend",
    PRECOMPILES.contractDeployerAllowList,
    ADDRESSES.backend,
    ROLES.none,
  );
  await expectRole(
    "NativeMinter dripper",
    PRECOMPILES.contractNativeMinter,
    ADDRESSES.dripper,
    ROLES.enabled,
  );
  await expectRole(
    "NativeMinter backend",
    PRECOMPILES.contractNativeMinter,
    ADDRESSES.backend,
    ROLES.none,
  );
  await expectRole("FeeManager admin", PRECOMPILES.feeManager, ADDRESSES.admin, ROLES.admin);
  await expectRole("FeeManager backend", PRECOMPILES.feeManager, ADDRESSES.backend, ROLES.none);

  const deployHash = await walletClient.sendTransaction({
    account: deployer,
    chain: benzoNet,
    data: EMPTY_RUNTIME_DEPLOY_BYTECODE,
    gas: 1_000_000n,
    gasPrice: MIN_BASE_FEE,
  });
  const deployReceipt = await waitForTransaction(deployHash);
  if (!deployReceipt.contractAddress) {
    throw new Error("Allowed deployer transaction did not create a contract.");
  }
  console.log(`ok: deployer deployed ${deployReceipt.contractAddress}`);

  await expectRejected("non-deployer contract creation", async () => {
    const hash = await walletClient.sendTransaction({
      account: backend,
      chain: benzoNet,
      data: EMPTY_RUNTIME_DEPLOY_BYTECODE,
      gas: 1_000_000n,
      gasPrice: MIN_BASE_FEE,
    });
    await waitForTransaction(hash);
  });

  const mintHash = await walletClient.writeContract({
    account: dripper,
    address: PRECOMPILES.contractNativeMinter,
    abi: NATIVE_MINTER_ABI,
    functionName: "mintNativeCoin",
    args: [unlisted.address, MINT_AMOUNT],
    chain: benzoNet,
    gas: 100_000n,
    gasPrice: MIN_BASE_FEE,
  });
  await waitForTransaction(mintHash);
  const unlistedBalance = await publicClient.getBalance({ address: unlisted.address });
  if (unlistedBalance < MINT_AMOUNT) {
    throw new Error(`Dripper mint did not fund unlisted address; balance is ${unlistedBalance}.`);
  }
  console.log(`ok: dripper minted ${MINT_AMOUNT} wei to ${unlisted.address}`);

  await expectRejected("unlisted normal transaction", async () => {
    const hash = await walletClient.sendTransaction({
      account: unlisted,
      chain: benzoNet,
      to: unlisted.address,
      value: 1n,
      gas: 21_000n,
      gasPrice: MIN_BASE_FEE,
    });
    await waitForTransaction(hash);
  });

  await expectRejected("non-minter native mint", async () => {
    const hash = await walletClient.writeContract({
      account: backend,
      address: PRECOMPILES.contractNativeMinter,
      abi: NATIVE_MINTER_ABI,
      functionName: "mintNativeCoin",
      args: [backend.address, 1n],
      chain: benzoNet,
      gas: 100_000n,
      gasPrice: MIN_BASE_FEE,
    });
    await waitForTransaction(hash);
  });

  await expectRejected("non-admin fee config change", async () => {
    const hash = await walletClient.writeContract({
      account: backend,
      address: PRECOMPILES.feeManager,
      abi: FEE_MANAGER_ABI,
      functionName: "setFeeConfig",
      args: FEE_CONFIG_ARGS,
      chain: benzoNet,
      gas: 200_000n,
      gasPrice: MIN_BASE_FEE,
    });
    await waitForTransaction(hash);
  });

  console.log("BenzoNet local allowlist smoke tests passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
