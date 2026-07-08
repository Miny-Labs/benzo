import {
	BaseError,
	ContractFunctionRevertedError,
	createWalletClient,
	getAddress,
	http,
	toFunctionSelector,
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
	relayerAddress: Address | null;
	settleDeposit: (input: SettleDepositInput) => Promise<SettleDepositResult>;
};

export class OnrampRecipientNotRegisteredError extends Error {
	constructor(cause?: unknown) {
		super("recipient_not_eerc_registered", { cause });
		this.name = "OnrampRecipientNotRegisteredError";
	}
}

export class OnrampRelayerUnavailableError extends Error {
	constructor(reason: "onramp_relayer_unconfigured" | "onramp_router_unconfigured") {
		super(reason);
		this.name = "OnrampRelayerUnavailableError";
	}
}

export class OnrampSettleRetryableError extends Error {
	readonly txHash: Hex | null;

	constructor(message: string, cause?: unknown, txHash: Hex | null = null) {
		super(message, { cause });
		this.name = "OnrampSettleRetryableError";
		this.txHash = txHash;
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
	{
		inputs: [{ name: "nonce", type: "bytes32" }],
		name: "CctpNonceAlreadyUsed",
		type: "error",
	},
] as const;

const CCTP_REPLAY_ERROR_SELECTOR = toFunctionSelector(
	"CctpNonceAlreadyUsed(bytes32)",
);
const SETTLE_GAS_BUFFER_NUMERATOR = 12n;
const SETTLE_GAS_BUFFER_DENOMINATOR = 10n;
const SETTLE_RECEIPT_TIMEOUT_MS = 120_000;

export function createViemOnrampRelayer(
	config: ApiConfig,
	publicClient: PublicClient,
): OnrampRelayer {
	if (!config.relayerPrivateKey) {
		return createUnavailableRelayer("onramp_relayer_unconfigured");
	}

	const account = privateKeyToAccount(config.relayerPrivateKey as Hex);

	if (!config.autoDepositRouterAddress) {
		return createUnavailableRelayer(
			"onramp_router_unconfigured",
			account.address,
		);
	}

	const routerAddress = getAddress(config.autoDepositRouterAddress);
	const walletClient = createWalletClient({
		account,
		transport: http(config.benzonetRpcUrl),
	});

	return {
		relayerAddress: account.address,
		async settleDeposit(input) {
			const args = [input.message, input.attestation, input.amountPCT] as const;
			let gas: bigint;
			let txHash: Hex;

			try {
				gas = addGasBuffer(
					await publicClient.estimateContractGas({
						abi: routerAbi,
						account: account.address,
						address: routerAddress,
						args,
						functionName: "settleDeposit",
					}),
				);
			} catch (error) {
				return handleSettleSendError(error, "onramp_settle_estimate_failed");
			}

			try {
				txHash = await walletClient.writeContract({
					abi: routerAbi,
					account,
					address: routerAddress,
					args,
					chain: null,
					functionName: "settleDeposit",
					gas,
				});
			} catch (error) {
				return handleSettleSendError(error, "onramp_settle_send_failed");
			}

			const receipt = await publicClient
				.waitForTransactionReceipt({
					confirmations: input.confirmations ?? 1,
					hash: txHash,
					timeout: SETTLE_RECEIPT_TIMEOUT_MS,
				})
				.catch((error: unknown) => {
					throw new OnrampSettleRetryableError(
						"onramp_settle_confirmation_failed",
						error,
						txHash,
					);
				});

			if (receipt.status === "reverted") {
				throw new OnrampSettleRetryableError(
					"onramp_settle_reverted",
					undefined,
					txHash,
				);
			}

			return { alreadySettled: false, txHash };
		},
	};
}

function createUnavailableRelayer(
	reason: "onramp_relayer_unconfigured" | "onramp_router_unconfigured",
	relayerAddress: Address | null = null,
): OnrampRelayer {
	return {
		relayerAddress,
		async settleDeposit() {
			throw new OnrampRelayerUnavailableError(reason);
		},
	};
}

function handleSettleSendError(
	error: unknown,
	message: string,
): SettleDepositResult {
	if (isRecipientNotRegisteredError(error)) {
		throw new OnrampRecipientNotRegisteredError(error);
	}

	if (isCctpMessageReplayError(error)) {
		return { alreadySettled: true, txHash: null };
	}

	throw new OnrampSettleRetryableError(message, error);
}

function addGasBuffer(gas: bigint): bigint {
	return (gas * SETTLE_GAS_BUFFER_NUMERATOR) / SETTLE_GAS_BUFFER_DENOMINATOR;
}

function isRecipientNotRegisteredError(error: unknown): boolean {
	return readContractRevertName(error) === "RecipientNotRegistered";
}

export function isCctpMessageReplayError(error: unknown): boolean {
	const revertError = readContractRevertError(error);

	return (
		revertError?.data?.errorName === "CctpNonceAlreadyUsed" ||
		revertError?.raw?.slice(0, 10) === CCTP_REPLAY_ERROR_SELECTOR
	);
}

function readContractRevertName(error: unknown): string | undefined {
	return readContractRevertError(error)?.data?.errorName;
}

function readContractRevertError(
	error: unknown,
): ContractFunctionRevertedError | undefined {
	if (!(error instanceof BaseError)) {
		return undefined;
	}

	const revertError = error.walk(
		(cause) => cause instanceof ContractFunctionRevertedError,
	);

	if (!(revertError instanceof ContractFunctionRevertedError)) {
		return undefined;
	}

	return revertError;
}
