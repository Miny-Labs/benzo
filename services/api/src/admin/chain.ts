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
import type { AuditorPublicKey } from "../auditor/crypto.js";

export type AllowlistAction = "enable" | "revoke";

export type AllowlistActionResult = {
	action: AllowlistAction;
	address: string;
	enabled: boolean;
	previousLevel: string | null;
	result:
		| "already_enabled"
		| "already_revoked"
		| "enabled"
		| "noop_fuji_no_tx_allowlist"
		| "revoked";
	txHash: string | null;
};

export type AllowlistStatus = {
	address: string;
	enabled: boolean;
	level: string | null;
};

export type AdminDripResult = {
	address: string;
	amountWei: string;
	mode: "benzonet_native_minter" | "fuji_plain_transfer";
	txHash: string;
};

export type ChainBalance = {
	address: string;
	balanceWei: string;
};

export type ChainHealth = {
	blockLagSeconds: number;
	blockTimestamp: string;
	latestBlock: string;
	opsBalance: ChainBalance;
	treasuryBalances: ChainBalance[];
};

export type AuditorRotationChainResult = {
	auditorAddress: string | null;
	blockNumber: bigint;
	blockTime: Date;
	rotationLogIndex: number | null;
	rotationTransactionIndex: number | null;
	txHash: string;
};

export type AuditorRotationInput = {
	auditorAddress?: string;
	publicKey: AuditorPublicKey;
};

export type AdminChainClient = {
	applyAllowlist: (
		address: string,
		action: AllowlistAction,
	) => Promise<AllowlistActionResult>;
	dripGas: (address: string, amountWei: bigint) => Promise<AdminDripResult>;
	getAllowlistStatus: (address: string) => Promise<AllowlistStatus>;
	getChainHealth: (treasuryAddresses: string[]) => Promise<ChainHealth>;
	rotateAuditor: (
		input: AuditorRotationInput,
	) => Promise<AuditorRotationChainResult>;
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
	{
		inputs: [{ name: "user", type: "address" }],
		name: "setNone",
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

const encryptedErcPublicKeyAdminAbi = [
	{
		inputs: [{ name: "publicKey", type: "uint256[2]" }],
		name: "setAuditorPublicKey",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const encryptedErcAddressAdminAbi = [
	{
		inputs: [{ name: "user", type: "address" }],
		name: "setAuditorPublicKey",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const encryptedErcAuditorPublicKeyAbi = [
	{
		inputs: [],
		name: "auditorPublicKey",
		outputs: [{ name: "", type: "uint256[2]" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

const registrarPublicKeyAbi = [
	{
		inputs: [{ name: "user", type: "address" }],
		name: "getUserPublicKey",
		outputs: [{ name: "publicKey", type: "uint256[2]" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

export function createAdminChainClient(
	config: ApiConfig,
	publicClient: PublicClient,
): AdminChainClient {
	const account = privateKeyToAccount(config.opsPrivateKey as Hex);
	const walletClient = createWalletClient({
		account,
		transport: http(config.benzonetRpcUrl),
	});

	return {
		async applyAllowlist(address, action) {
			const user = normalizeAddress(address);

			if (config.chainEnv === "fuji") {
				return {
					action,
					address: user.toLowerCase(),
					enabled: true,
					previousLevel: null,
					result: "noop_fuji_no_tx_allowlist",
					txHash: null,
				};
			}

			const previousLevel = await readAllowList(publicClient, user);

			if (action === "enable" && previousLevel >= 1n) {
				return {
					action,
					address: user.toLowerCase(),
					enabled: true,
					previousLevel: previousLevel.toString(),
					result: "already_enabled",
					txHash: null,
				};
			}

			if (action === "revoke" && previousLevel === 0n) {
				return {
					action,
					address: user.toLowerCase(),
					enabled: false,
					previousLevel: previousLevel.toString(),
					result: "already_revoked",
					txHash: null,
				};
			}

			const txHash = await walletClient.writeContract({
				abi: allowListAbi,
				account,
				address: allowListAddress,
				args: [user],
				chain: null,
				functionName: action === "enable" ? "setEnabled" : "setNone",
			});

			await publicClient.waitForTransactionReceipt({
				confirmations: 2,
				hash: txHash,
			});

			return {
				action,
				address: user.toLowerCase(),
				enabled: action === "enable",
				previousLevel: previousLevel.toString(),
				result: action === "enable" ? "enabled" : "revoked",
				txHash,
			};
		},
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
					address: recipient.toLowerCase(),
					amountWei: amountWei.toString(),
					mode: "fuji_plain_transfer",
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

			await publicClient.waitForTransactionReceipt({
				confirmations: 2,
				hash: txHash,
			});

			return {
				address: recipient.toLowerCase(),
				amountWei: amountWei.toString(),
				mode: "benzonet_native_minter",
				txHash,
			};
		},
		async getAllowlistStatus(address) {
			const user = normalizeAddress(address);

			if (config.chainEnv === "fuji") {
				return {
					address: user.toLowerCase(),
					enabled: true,
					level: null,
				};
			}

			const level = await readAllowList(publicClient, user);

			return {
				address: user.toLowerCase(),
				enabled: level >= 1n,
				level: level.toString(),
			};
		},
		async getChainHealth(treasuryAddresses) {
			const latestBlock = await publicClient.getBlockNumber();
			const block = await publicClient.getBlock({ blockNumber: latestBlock });
			const blockTimestamp = new Date(Number(block.timestamp) * 1_000);
			const [opsBalance, treasuryBalances] = await Promise.all([
				publicClient.getBalance({ address: account.address }),
				Promise.all(
					treasuryAddresses.map(async (address) => ({
						address: normalizeAddress(address).toLowerCase(),
						balanceWei: (
							await publicClient.getBalance({
								address: normalizeAddress(address),
							})
						).toString(),
					})),
				),
			]);

			return {
				blockLagSeconds: Math.max(
					0,
					Math.floor((Date.now() - blockTimestamp.getTime()) / 1_000),
				),
				blockTimestamp: blockTimestamp.toISOString(),
				latestBlock: latestBlock.toString(),
				opsBalance: {
					address: account.address.toLowerCase(),
					balanceWei: opsBalance.toString(),
				},
				treasuryBalances,
			};
		},
		async rotateAuditor(input) {
			const encryptedErcAddress = normalizeAddress(config.eercEncryptedErcAddress);
			const auditorAddress =
				input.auditorAddress === undefined
					? undefined
					: normalizeAddress(input.auditorAddress);

			if (auditorAddress !== undefined) {
				await assertRegisteredAuditorPublicKey(
					publicClient,
					normalizeAddress(config.eercRegistrarAddress),
					auditorAddress,
					input.publicKey,
				);
			}

			const txHash =
				auditorAddress === undefined
					? await walletClient.writeContract({
							abi: encryptedErcPublicKeyAdminAbi,
							account,
							address: encryptedErcAddress,
							args: [[BigInt(input.publicKey[0]), BigInt(input.publicKey[1])]],
							chain: null,
							functionName: "setAuditorPublicKey",
						})
					: await walletClient.writeContract({
							abi: encryptedErcAddressAdminAbi,
							account,
							address: encryptedErcAddress,
							args: [auditorAddress],
							chain: null,
							functionName: "setAuditorPublicKey",
						});
			const receipt = await publicClient.waitForTransactionReceipt({
				confirmations: 2,
				hash: txHash,
			});
			const blockNumber = receipt.blockNumber ?? (await publicClient.getBlockNumber());
			const block = await publicClient.getBlock({ blockNumber });
			const rotationLogIndex = firstReceiptLogIndex(receipt.logs);

			if (auditorAddress !== undefined) {
				await assertEncryptedErcAuditorPublicKey(
					publicClient,
					encryptedErcAddress,
					input.publicKey,
				);
			}

			return {
				auditorAddress: auditorAddress?.toLowerCase() ?? null,
				blockNumber,
				blockTime: new Date(Number(block.timestamp) * 1_000),
				rotationLogIndex,
				rotationTransactionIndex: receipt.transactionIndex,
				txHash,
			};
		},
	};
}

async function readAllowList(
	publicClient: PublicClient,
	user: Address,
): Promise<bigint> {
	return publicClient.readContract({
		abi: allowListAbi,
		address: allowListAddress,
		args: [user],
		functionName: "readAllowList",
	});
}

function normalizeAddress(address: string): Address {
	return getAddress(address) as Address;
}

async function assertRegisteredAuditorPublicKey(
	publicClient: PublicClient,
	registrarAddress: Address,
	auditorAddress: Address,
	expectedPublicKey: AuditorPublicKey,
): Promise<void> {
	const registeredPublicKey = await publicClient.readContract({
		abi: registrarPublicKeyAbi,
		address: registrarAddress,
		args: [auditorAddress],
		functionName: "getUserPublicKey",
	});

	if (!publicKeysEqual(registeredPublicKey, expectedPublicKey)) {
		throw new Error("auditor_public_key_mismatch");
	}
}

async function assertEncryptedErcAuditorPublicKey(
	publicClient: PublicClient,
	encryptedErcAddress: Address,
	expectedPublicKey: AuditorPublicKey,
): Promise<void> {
	const onChainPublicKey = await publicClient.readContract({
		abi: encryptedErcAuditorPublicKeyAbi,
		address: encryptedErcAddress,
		functionName: "auditorPublicKey",
	});

	if (!publicKeysEqual(onChainPublicKey, expectedPublicKey)) {
		throw new Error("auditor_public_key_mismatch");
	}
}

function publicKeysEqual(
	left: readonly bigint[],
	right: AuditorPublicKey,
): boolean {
	return (
		left.length === 2 &&
		left[0]?.toString() === right[0] &&
		left[1]?.toString() === right[1]
	);
}

function firstReceiptLogIndex(
	logs: readonly { logIndex: number | null }[],
): number | null {
	return logs.reduce<number | null>((firstLogIndex, log) => {
		if (log.logIndex === null) {
			return firstLogIndex;
		}

		return firstLogIndex === null
			? log.logIndex
			: Math.min(firstLogIndex, log.logIndex);
	}, null);
}
