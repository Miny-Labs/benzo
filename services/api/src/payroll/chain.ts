import {
	createWalletClient,
	encodeFunctionData,
	getAddress,
	http,
	keccak256,
	type Address,
	type Hex,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiConfig } from "../config.js";
import {
	buildRegistrationProofInput,
	createManagedEercAccount,
	type EercBalance,
	flattenEncryptedBalance,
	getDecryptedBalance,
	type ManagedEercAccount,
	normalizeEercBalance,
	normalizePublicKey,
	type PoseidonPCT,
	type TransferProofCalldata,
} from "./eerc.js";
import type { PayrollProver } from "./prover.js";

export type TreasuryRegistrationResult = {
	alreadyRegistered: boolean;
	eercAccount: ManagedEercAccount;
	txHash: Hex | null;
};

export type TreasuryRegistrar = {
	registerTreasury: (input: {
		address: string;
		eercAccount?: ManagedEercAccount;
		eoaPrivateKey: Hex;
	}) => Promise<TreasuryRegistrationResult>;
};

export type TransferContext = {
	auditorPublicKey: [bigint, bigint];
	receiverPublicKey: [bigint, bigint];
	senderBalance: bigint;
	senderEncryptedBalance: bigint[];
};

export type TransferSubmissionInput = {
	balancePCT: [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
	eoaPrivateKey: Hex;
	proof: TransferProofCalldata;
	recipientAddress: string;
	tokenId: bigint;
};

export type PreparedTransferSubmission = {
	rawTransaction: Hex;
	txHash: Hex;
};

export type TreasuryDepositSubmissionInput = {
	amount: bigint;
	amountPCT: PoseidonPCT;
	confirmations?: number;
	eoaPrivateKey: Hex;
	// Invoked with the deposit tx hash the moment it is broadcast, before the
	// confirmation wait, so the ledger can track a broadcast-but-unconfirmed tx.
	onBroadcast?: (txHash: Hex) => void | Promise<void>;
	tokenAddress: string;
};

export type TreasuryDepositSubmissionResult = {
	approvalTxHash: Hex;
	txHash: Hex;
};

export type PayrollSubmitter = {
	loadTreasuryBalance: (input: {
		tokenId: bigint;
		treasuryAddress: string;
	}) => Promise<EercBalance>;
	loadTransferContext: (input: {
		recipientAddress: string;
		sender: ManagedEercAccount;
		treasuryAddress: string;
		tokenId: bigint;
	}) => Promise<TransferContext>;
	prepareTransfer: (
		input: TransferSubmissionInput,
	) => Promise<PreparedTransferSubmission>;
	submitPreparedTransfer: (
		input: PreparedTransferSubmission,
	) => Promise<{ txHash: Hex }>;
	submitTreasuryDeposit: (
		input: TreasuryDepositSubmissionInput,
	) => Promise<TreasuryDepositSubmissionResult>;
	waitForConfirmations: (txHash: Hex, confirmations: number) => Promise<void>;
};

const proofPointsAbi = [
	{ name: "a", type: "uint256[2]" },
	{ name: "b", type: "uint256[2][2]" },
	{ name: "c", type: "uint256[2]" },
] as const;

const registrarAbi = [
	{
		inputs: [{ name: "user", type: "address" }],
		name: "isUserRegistered",
		outputs: [{ name: "registered", type: "bool" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ name: "user", type: "address" }],
		name: "getUserPublicKey",
		outputs: [{ name: "publicKey", type: "uint256[2]" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				components: [
					{
						components: proofPointsAbi,
						name: "proofPoints",
						type: "tuple",
					},
					{ name: "publicSignals", type: "uint256[5]" },
				],
				name: "proof",
				type: "tuple",
			},
		],
		name: "register",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const encryptedErcAbi = [
	{
		inputs: [],
		name: "auditorPublicKey",
		outputs: [
			{ name: "x", type: "uint256" },
			{ name: "y", type: "uint256" },
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{ name: "user", type: "address" },
			{ name: "tokenId", type: "uint256" },
		],
		name: "balanceOf",
		outputs: [
			{
				components: [
					{
						components: [
							{ name: "x", type: "uint256" },
							{ name: "y", type: "uint256" },
						],
						name: "c1",
						type: "tuple",
					},
					{
						components: [
							{ name: "x", type: "uint256" },
							{ name: "y", type: "uint256" },
						],
						name: "c2",
						type: "tuple",
					},
				],
				name: "eGCT",
				type: "tuple",
			},
			{ name: "nonce", type: "uint256" },
			{
				components: [
					{ name: "pct", type: "uint256[7]" },
					{ name: "index", type: "uint256" },
				],
				name: "amountPCTs",
				type: "tuple[]",
			},
			{ name: "balancePCT", type: "uint256[7]" },
			{ name: "transactionIndex", type: "uint256" },
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{ name: "to", type: "address" },
			{ name: "tokenId", type: "uint256" },
			{
				components: [
					{
						components: proofPointsAbi,
						name: "proofPoints",
						type: "tuple",
					},
					{ name: "publicSignals", type: "uint256[32]" },
				],
				name: "proof",
				type: "tuple",
			},
			{ name: "balancePCT", type: "uint256[7]" },
		],
		name: "transfer",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{ name: "amount", type: "uint256" },
			{ name: "tokenAddress", type: "address" },
			{ name: "amountPCT", type: "uint256[7]" },
		],
		name: "deposit",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const erc20Abi = [
	{
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		name: "approve",
		outputs: [{ name: "ok", type: "bool" }],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

export function createViemTreasuryRegistrar(
	config: ApiConfig,
	publicClient: PublicClient,
	prover: PayrollProver,
): TreasuryRegistrar {
	return {
		async registerTreasury(input) {
			const address = normalizeAddress(input.address);
			const eercAccount = input.eercAccount ?? createManagedEercAccount();
			const registered = await publicClient.readContract({
				abi: registrarAbi,
				address: normalizeAddress(config.eercRegistrarAddress),
				args: [address],
				functionName: "isUserRegistered",
			});

			if (registered) {
				const publicKey = normalizePublicKey(
					await publicClient.readContract({
						abi: registrarAbi,
						address: normalizeAddress(config.eercRegistrarAddress),
						args: [address],
						functionName: "getUserPublicKey",
					}),
					"treasuryPublicKey",
				);

				if (
					publicKey[0] !== eercAccount.publicKey[0] ||
					publicKey[1] !== eercAccount.publicKey[1]
				) {
					throw new Error("treasury_registered_with_different_eerc_key");
				}

				return {
					alreadyRegistered: true,
					eercAccount,
					txHash: null,
				};
			}

			const proof = await prover.proveRegistration(
				buildRegistrationProofInput(
					eercAccount,
					address,
					BigInt(config.benzonetChainId),
				),
			);
			const account = privateKeyToAccount(input.eoaPrivateKey);
			const walletClient = createWalletClient({
				account,
				transport: http(config.benzonetRpcUrl),
			});
			const txHash = await walletClient.writeContract({
				abi: registrarAbi,
				account,
				address: normalizeAddress(config.eercRegistrarAddress),
				args: [proof],
				chain: null,
				functionName: "register",
			});
			const receipt = await publicClient.waitForTransactionReceipt({
				confirmations: 1,
				hash: txHash,
			});
			throwIfRevertedReceipt(receipt, "treasury_registration_reverted");

			return {
				alreadyRegistered: false,
				eercAccount,
				txHash,
			};
		},
	};
}

export function createViemPayrollSubmitter(
	config: ApiConfig,
	publicClient: PublicClient,
): PayrollSubmitter {
	const encryptedErcAddress = normalizeAddress(config.eercEncryptedErcAddress);
	const converterAddress = normalizeAddress(config.eercConverterAddress);
	const loadTreasuryBalance = async (input: {
		tokenId: bigint;
		treasuryAddress: string;
	}): Promise<EercBalance> =>
		normalizeEercBalance(
			await publicClient.readContract({
				abi: encryptedErcAbi,
				address: encryptedErcAddress,
				args: [normalizeAddress(input.treasuryAddress), input.tokenId],
				functionName: "balanceOf",
			}),
		);
	const waitForReceipt = async (
		txHash: Hex,
		confirmations: number,
		revertMessage: string,
	): Promise<void> => {
		const receipt = await publicClient.waitForTransactionReceipt({
			confirmations,
			hash: txHash,
		});
		throwIfRevertedReceipt(receipt, revertMessage);
	};

	return {
		loadTreasuryBalance,
		async loadTransferContext(input) {
			const recipient = normalizeAddress(input.recipientAddress);
			const registered = await publicClient.readContract({
				abi: registrarAbi,
				address: normalizeAddress(config.eercRegistrarAddress),
				args: [recipient],
				functionName: "isUserRegistered",
			});

			if (!registered) {
				throw new Error("recipient_not_eerc_registered");
			}

			const receiverPublicKey = normalizePublicKey(
				await publicClient.readContract({
					abi: registrarAbi,
					address: normalizeAddress(config.eercRegistrarAddress),
					args: [recipient],
					functionName: "getUserPublicKey",
				}),
				"receiverPublicKey",
			);
			const auditorPublicKey = normalizePublicKey(
				await publicClient.readContract({
					abi: encryptedErcAbi,
					address: normalizeAddress(config.eercEncryptedErcAddress),
					functionName: "auditorPublicKey",
				}),
				"auditorPublicKey",
			);
			if (auditorPublicKey[0] === 0n && auditorPublicKey[1] <= 1n) {
				throw new Error("auditor_public_key_not_set");
			}

			const balance = await loadTreasuryBalance({
				tokenId: input.tokenId,
				treasuryAddress: input.treasuryAddress,
			});

			return {
				auditorPublicKey,
				receiverPublicKey,
				senderBalance: getDecryptedBalance(input.sender.privateKey, balance),
				senderEncryptedBalance: flattenEncryptedBalance(balance),
			};
		},
		async prepareTransfer(input) {
			const account = privateKeyToAccount(input.eoaPrivateKey);
			const walletClient = createWalletClient({
				account,
				transport: http(config.benzonetRpcUrl),
			});
			const data = encodeFunctionData({
				abi: encryptedErcAbi,
				args: [
					normalizeAddress(input.recipientAddress),
					input.tokenId,
					input.proof,
					input.balancePCT,
				],
				functionName: "transfer",
			});
			const request = await walletClient.prepareTransactionRequest({
				account,
				chain: null,
				data,
				to: encryptedErcAddress,
			});
			const rawTransaction = await walletClient.signTransaction({
				...request,
				chain: null,
			});

			return {
				rawTransaction,
				txHash: keccak256(rawTransaction),
			};
		},
		async submitPreparedTransfer(input) {
			try {
				const submittedHash = await publicClient.sendRawTransaction({
					serializedTransaction: input.rawTransaction,
				});
				if (submittedHash.toLowerCase() !== input.txHash.toLowerCase()) {
					throw new Error("submitted_transfer_hash_mismatch");
				}
			} catch (error) {
				if (!isIdempotentRawTransactionError(error)) {
					throw error;
				}
			}

			return { txHash: input.txHash };
		},
		async submitTreasuryDeposit(input) {
			if (input.amount <= 0n) {
				throw new Error("invalid_treasury_deposit_amount");
			}

			const account = privateKeyToAccount(input.eoaPrivateKey);
			const walletClient = createWalletClient({
				account,
				transport: http(config.benzonetRpcUrl),
			});
			// A single confirmation can be undone by a reorg; fall back to the same
			// depth the indexer trusts (default 6) so a persisted `confirmed`
			// deposit reflects a tx that actually settled.
			const confirmations = input.confirmations ?? config.indexerConfirmations;
			const tokenAddress = normalizeAddress(input.tokenAddress);
			const approvalTxHash = await walletClient.writeContract({
				abi: erc20Abi,
				account,
				address: tokenAddress,
				args: [converterAddress, input.amount],
				chain: null,
				functionName: "approve",
			});
			await waitForReceipt(
				approvalTxHash,
				confirmations,
				"treasury_deposit_approval_reverted",
			);

			const txHash = await walletClient.writeContract({
				abi: encryptedErcAbi,
				account,
				address: converterAddress,
				args: [input.amount, tokenAddress, input.amountPCT],
				chain: null,
				functionName: "deposit",
			});
			// Surface the deposit hash before the confirmation wait: if that wait
			// fails, the tx may still land, so the ledger must persist the hash now
			// rather than only after `confirmed`.
			await input.onBroadcast?.(txHash);
			await waitForReceipt(
				txHash,
				confirmations,
				"treasury_deposit_reverted",
			);

			return { approvalTxHash, txHash };
		},
		async waitForConfirmations(txHash, confirmations) {
			await waitForReceipt(txHash, confirmations, "transfer_reverted");
		},
	};
}

function normalizeAddress(address: string): Address {
	return getAddress(address) as Address;
}

function throwIfRevertedReceipt(
	receipt: { status?: "success" | "reverted" | string },
	message: string,
): void {
	if (receipt.status === "reverted") {
		throw new Error(message);
	}
}

function isIdempotentRawTransactionError(error: unknown): boolean {
	const message =
		error instanceof Error
			? `${error.name} ${error.message}`.toLowerCase()
			: String(error).toLowerCase();
	return [
		"already known",
		"already imported",
		"already in chain",
		"known transaction",
		"nonce too low",
		"transaction already exists",
	].some((needle) => message.includes(needle));
}
