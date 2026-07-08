import {
	BaseError,
	ContractFunctionRevertedError,
	createWalletClient,
	getAddress,
	http,
	type Address,
	type Hex,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiConfig } from "../config.js";
import type { PoseidonPCT } from "../payroll/eerc.js";

export type SettleDepositInput = {
	amountPCT: PoseidonPCT;
	attestation: Hex;
	confirmations?: number;
	message: Hex;
};

export type SettleDepositResult = {
	alreadySettled: boolean;
	txHash: Hex | null;
};

export type OnrampRelayer = {
	relayerAddress: Address;
	settleDeposit: (input: SettleDepositInput) => Promise<SettleDepositResult>;
};

export class OnrampRecipientNotRegisteredError extends Error {
	constructor(cause?: unknown) {
		super("recipient_not_eerc_registered", { cause });
		this.name = "OnrampRecipientNotRegisteredError";
	}
}

const routerAbi = [
	{
		inputs: [
			{ name: "message", type: "bytes" },
			{ name: "attestation", type: "bytes" },
			{ name: "amountPCT", type: "uint256[7]" },
		],
		name: "settleDeposit",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [{ name: "caller", type: "address" }],
		name: "NotRelayer",
		type: "error",
	},
	{ inputs: [], name: "MessageReceiveFailed", type: "error" },
	{
		inputs: [{ name: "token", type: "address" }],
		name: "TokenNotAllowed",
		type: "error",
	},
	{
		inputs: [
			{ name: "expected", type: "address" },
			{ name: "actual", type: "address" },
		],
		name: "MintRecipientMismatch",
		type: "error",
	},
	{
		inputs: [{ name: "user", type: "address" }],
		name: "RecipientNotRegistered",
		type: "error",
	},
	{
		inputs: [
			{ name: "user", type: "address" },
			{ name: "expectedPkX", type: "uint256" },
			{ name: "expectedPkY", type: "uint256" },
			{ name: "actualPkX", type: "uint256" },
			{ name: "actualPkY", type: "uint256" },
		],
		name: "PublicKeyMismatch",
		type: "error",
	},
] as const;

export function createViemOnrampRelayer(
	config: ApiConfig,
	publicClient: PublicClient,
): OnrampRelayer {
	const account = privateKeyToAccount(config.relayerPrivateKey as Hex);
	const walletClient = createWalletClient({
		account,
		transport: http(config.benzonetRpcUrl),
	});

	return {
		relayerAddress: account.address,
		async settleDeposit(input) {
			if (!config.autoDepositRouterAddress) {
				throw new Error("onramp_router_unconfigured");
			}

			let txHash: Hex;

			try {
				txHash = await walletClient.writeContract({
					abi: routerAbi,
					account,
					address: getAddress(config.autoDepositRouterAddress),
					args: [input.message, input.attestation, input.amountPCT],
					chain: null,
					functionName: "settleDeposit",
				});
			} catch (error) {
				if (isRecipientNotRegisteredError(error)) {
					throw new OnrampRecipientNotRegisteredError(error);
				}

				if (isReplayError(error)) {
					return { alreadySettled: true, txHash: null };
				}

				throw error;
			}

			const receipt = await publicClient.waitForTransactionReceipt({
				confirmations: input.confirmations ?? 1,
				hash: txHash,
			});

			if (receipt.status === "reverted") {
				throw new Error("onramp_settle_reverted");
			}

			return { alreadySettled: false, txHash };
		},
	};
}

function isRecipientNotRegisteredError(error: unknown): boolean {
	return readContractRevertName(error) === "RecipientNotRegistered";
}

function isReplayError(error: unknown): boolean {
	const revertName = readContractRevertName(error)?.toLowerCase();
	const message =
		error instanceof Error
			? `${error.name} ${error.message}`.toLowerCase()
			: String(error).toLowerCase();

	return (
		revertName === "cctpnoncealreadyused" ||
		revertName === "messagealreadyprocessed" ||
		message.includes("cctpnoncealreadyused") ||
		message.includes("message already processed") ||
		message.includes("nonce already used") ||
		message.includes("already used nonce") ||
		message.includes("already processed")
	);
}

function readContractRevertName(error: unknown): string | undefined {
	if (!(error instanceof BaseError)) {
		return undefined;
	}

	const revertError = error.walk(
		(cause) => cause instanceof ContractFunctionRevertedError,
	);

	if (!(revertError instanceof ContractFunctionRevertedError)) {
		return undefined;
	}

	return revertError.data?.errorName;
}
