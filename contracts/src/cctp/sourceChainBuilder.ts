import {
	CCTP_DOMAINS,
	CCTP_SOURCE_CHAINS,
	type CctpChain,
	type CctpDomain,
	type CctpStablecoinSymbol,
	type DeploymentTier,
} from "@benzo/config";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { encodeHookData } from "./hookData";

export const DEFAULT_CCTP_ONRAMP_TIER: DeploymentTier = "staging";
export const DEFAULT_CCTP_FAST_FINALITY_THRESHOLD = 1000;
export const DEFAULT_CCTP_MAX_FEE = 0n;

const UINT32_MAX = 2 ** 32 - 1;
const EURC_SOURCE_CHAINS = new Set<CctpChain>(["ethereum", "base"]);

export type UserEercPublicKey = {
	x: bigint;
	y: bigint;
};

export type BuildDepositForBurnWithHookArgsInput = {
	tier?: DeploymentTier;
	sourceChain: CctpChain;
	token: CctpStablecoinSymbol;
	amount: bigint;
	userAvalancheAddress: Address;
	userEercPubKey: UserEercPublicKey;
	routerAddress: Address;
	maxFee?: bigint;
	minFinalityThreshold?: number;
};

export type DepositForBurnWithHookArgs = {
	amount: bigint;
	destinationDomain: CctpDomain;
	mintRecipient: Hex;
	burnToken: Address;
	destinationCaller: Hex;
	maxFee: bigint;
	minFinalityThreshold: number;
	hookData: Hex;
};

export type DepositForBurnWithHookArgsTuple = readonly [
	amount: bigint,
	destinationDomain: CctpDomain,
	mintRecipient: Hex,
	burnToken: Address,
	destinationCaller: Hex,
	maxFee: bigint,
	minFinalityThreshold: number,
	hookData: Hex,
];

export function buildDepositForBurnWithHookArgs({
	tier = DEFAULT_CCTP_ONRAMP_TIER,
	sourceChain,
	token,
	amount,
	userAvalancheAddress,
	userEercPubKey,
	routerAddress,
	maxFee = DEFAULT_CCTP_MAX_FEE,
	minFinalityThreshold = DEFAULT_CCTP_FAST_FINALITY_THRESHOLD,
}: BuildDepositForBurnWithHookArgsInput): DepositForBurnWithHookArgs {
	if (amount <= 0n) {
		throw new Error("CCTP onramp amount must be greater than zero");
	}
	if (maxFee < 0n) {
		throw new Error("CCTP onramp maxFee cannot be negative");
	}

	const threshold = requireUint32(
		minFinalityThreshold,
		"minFinalityThreshold",
	);
	const source = CCTP_SOURCE_CHAINS[tier][sourceChain];
	if (!source) {
		throw new Error(
			`CCTP source chain ${sourceChain} is not configured for ${tier}`,
		);
	}
	if (token === "EURC" && !EURC_SOURCE_CHAINS.has(sourceChain)) {
		throw new Error("EURC CCTP onramp is only supported from Ethereum and Base");
	}

	const sourceToken = source.tokens[token];
	if (!sourceToken) {
		throw new Error(
			`${token} is not configured on CCTP source chain ${sourceChain} for ${tier}`,
		);
	}

	const router = requireAddress("routerAddress", routerAddress);
	const user = requireAddress("userAvalancheAddress", userAvalancheAddress);
	const routerBytes32 = addressToBytes32(router);

	return {
		amount,
		destinationDomain: CCTP_DOMAINS.avalanche,
		mintRecipient: routerBytes32,
		burnToken: getAddress(sourceToken.address),
		destinationCaller: routerBytes32,
		maxFee,
		minFinalityThreshold: threshold,
		hookData: encodeHookData({
			user,
			pkX: userEercPubKey.x,
			pkY: userEercPubKey.y,
		}),
	};
}

export function depositForBurnWithHookArgsTuple({
	amount,
	destinationDomain,
	mintRecipient,
	burnToken,
	destinationCaller,
	maxFee,
	minFinalityThreshold,
	hookData,
}: DepositForBurnWithHookArgs): DepositForBurnWithHookArgsTuple {
	return [
		amount,
		destinationDomain,
		mintRecipient,
		burnToken,
		destinationCaller,
		maxFee,
		minFinalityThreshold,
		hookData,
	] as const;
}

export function addressToBytes32(address: Address): Hex {
	const normalized = requireAddress("address", address);
	return `0x${normalized.slice(2).padStart(64, "0")}`.toLowerCase() as Hex;
}

function requireAddress(name: string, address: Address): Address {
	if (!isAddress(address)) {
		throw new Error(`${name} must be a valid EVM address`);
	}

	return getAddress(address);
}

function requireUint32(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
		throw new Error(`${name} must fit in uint32`);
	}

	return value;
}
