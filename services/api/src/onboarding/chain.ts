import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export type ChainEnv = "fuji" | "benzonet";

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
	let registrarAddressPromise: Promise<Address | null> | undefined;
	const walletClient = createWalletClient({
		account,
		transport: http(config.benzonetRpcUrl),
	});
	const getRegistrarAddress = (): Promise<Address | null> => {
		registrarAddressPromise ??= resolveRegistrarAddress(config);
		return registrarAddressPromise;
	};

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
			const registrarAddress = await getRegistrarAddress();

			if (!registrarAddress) {
				throw new Error("eerc_registrar_unconfigured");
			}

			return publicClient.readContract({
				abi: registrarAbi,
				address: registrarAddress,
				args: [normalizeAddress(address)],
				functionName: "isUserRegistered",
			});
		},
	};
}

function normalizeAddress(address: string): Address {
	return getAddress(address) as Address;
}

async function resolveRegistrarAddress(
	config: ApiConfig,
): Promise<Address | null> {
	if (config.eercRegistrarAddress) {
		return normalizeAddress(config.eercRegistrarAddress);
	}

	const manifestPath =
		config.eercDeploymentManifest ??
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			`../../../../contracts/deployments/${config.chainEnv}.json`,
		);

	try {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
		validateManifestMatchesConfig(manifest, config, manifestPath);
		return findRegistrarAddress(manifest);
	} catch (error) {
		if (isMissingFileError(error)) {
			return null;
		}

		throw error;
	}
}

function validateManifestMatchesConfig(
	manifest: unknown,
	config: ApiConfig,
	manifestPath: string,
): void {
	const manifestNetwork = readStringPath(manifest, ["network"]);

	if (manifestNetwork && manifestNetwork !== config.chainEnv) {
		throw new Error(
			`eerc_manifest_network_mismatch:${manifestPath}:${manifestNetwork}:${config.chainEnv}`,
		);
	}

	const manifestChainId = readNumberPath(manifest, ["chainId"]);

	if (manifestChainId !== null && manifestChainId !== config.benzonetChainId) {
		throw new Error(
			`eerc_manifest_chain_id_mismatch:${manifestPath}:${manifestChainId}:${config.benzonetChainId}`,
		);
	}
}

function findRegistrarAddress(manifest: unknown): Address | null {
	const candidates = [
		readStringPath(manifest, ["contracts", "registrar"]),
		readStringPath(manifest, ["contracts", "eercRegistrar"]),
		readStringPath(manifest, ["contracts", "encryptedERCRegistrar"]),
		readStringPath(manifest, ["registrar"]),
		readStringPath(manifest, ["eercRegistrar"]),
	];

	for (const candidate of candidates) {
		if (candidate && /^0x[0-9a-fA-F]{40}$/.test(candidate)) {
			return normalizeAddress(candidate);
		}
	}

	return null;
}

function readStringPath(value: unknown, keys: string[]): string | null {
	let cursor = value;

	for (const key of keys) {
		if (!cursor || typeof cursor !== "object" || !(key in cursor)) {
			return null;
		}

		cursor = (cursor as Record<string, unknown>)[key];
	}

	return typeof cursor === "string" ? cursor : null;
}

function readNumberPath(value: unknown, keys: string[]): number | null {
	let cursor = value;

	for (const key of keys) {
		if (!cursor || typeof cursor !== "object" || !(key in cursor)) {
			return null;
		}

		cursor = (cursor as Record<string, unknown>)[key];
	}

	return typeof cursor === "number" ? cursor : null;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
