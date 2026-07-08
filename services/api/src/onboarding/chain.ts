import {
	createWalletClient,
	getAddress,
	http,
	type Address,
	type Hex,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiConfig } from "../config.js";
import type { ChainEnv } from "../deployment-manifest.js";

export type { ChainEnv };

export type AllowlistStepResult =
	| {
			result: "already_enabled";
			txHash: null;
	  }
	| {
			result: "enabled";
			txHash: Hex;
	  }
	| {
			result: "noop_fuji_no_tx_allowlist";
			txHash: null;
	  };

export type GasDripStepResult =
	| {
			mode: "fuji_plain_transfer" | "benzonet_native_minter";
			result: "sent";
			txHash: Hex;
	  }
	| {
			mode: "none";
			result: "balance_sufficient";
			txHash: null;
	  };

export type OnboardingChainClient = {
	chainEnv: ChainEnv;
	chainId: number;
	dripGas: (address: string, amountWei: bigint) => Promise<GasDripStepResult>;
	ensureAllowlisted: (address: string) => Promise<AllowlistStepResult>;
	getNativeBalance: (address: string) => Promise<bigint>;
	isUserRegistered: (address: string) => Promise<boolean>;
};

const allowListAddress =
	"0x0200000000000000000000000000000000000002" as const;
const nativeMinterAddress =
	"0x0200000000000000000000000000000000000001" as const;

const allowListAbi = [
	{
		inputs: [{ name: "user", type: "address" }],
		name: "readAllowList",
		outputs: [{ name: "level", type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ name: "user", type: "address" }],
		name: "setEnabled",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const nativeMinterAbi = [
	{
		inputs: [
			{ name: "recipient", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		name: "mintNativeCoin",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const registrarAbi = [
	{
		inputs: [{ name: "user", type: "address" }],
		name: "isUserRegistered",
		outputs: [{ name: "registered", type: "bool" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

export function createOnboardingChainClient(
	config: ApiConfig,
	publicClient: PublicClient,
): OnboardingChainClient {
	const account = privateKeyToAccount(config.opsPrivateKey as Hex);
	const walletClient = createWalletClient({
		account,
		transport: http(config.benzonetRpcUrl),
	});

	return {
		chainEnv: config.chainEnv,
		chainId: config.benzonetChainId,
		async dripGas(address, amountWei) {
			const recipient = normalizeAddress(address);

			if (config.chainEnv === "fuji") {
				const txHash = await walletClient.sendTransaction({
					account,
					chain: null,
					to: recipient,
					value: amountWei,
				});

				return {
					mode: "fuji_plain_transfer",
					result: "sent",
					txHash,
				};
			}

			const txHash = await walletClient.writeContract({
				abi: nativeMinterAbi,
				account,
				address: nativeMinterAddress,
				args: [recipient, amountWei],
				chain: null,
				functionName: "mintNativeCoin",
			});

			return {
				mode: "benzonet_native_minter",
				result: "sent",
				txHash,
			};
		},
		async ensureAllowlisted(address) {
			const user = normalizeAddress(address);

			if (config.chainEnv === "fuji") {
				return {
					result: "noop_fuji_no_tx_allowlist",
					txHash: null,
				};
			}

			const level = await publicClient.readContract({
				abi: allowListAbi,
				address: allowListAddress,
				args: [user],
				functionName: "readAllowList",
			});

			if (level >= 1n) {
				return {
					result: "already_enabled",
					txHash: null,
				};
			}

			const txHash = await walletClient.writeContract({
				abi: allowListAbi,
				account,
				address: allowListAddress,
				args: [user],
				chain: null,
				functionName: "setEnabled",
			});

			return {
				result: "enabled",
				txHash,
			};
		},
		getNativeBalance(address) {
			return publicClient.getBalance({
				address: normalizeAddress(address),
			});
		},
		async isUserRegistered(address) {
			// config.eercRegistrarAddress is resolved from the deployment manifest
			// (or an explicit env override) at startup — see config.ts. There is no
			// second manifest-resolution path here.
			return publicClient.readContract({
				abi: registrarAbi,
				address: normalizeAddress(config.eercRegistrarAddress),
				args: [normalizeAddress(address)],
				functionName: "isUserRegistered",
			});
		},
	};
}

function normalizeAddress(address: string): Address {
	return getAddress(address) as Address;
}
