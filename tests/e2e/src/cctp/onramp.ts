import { type Hex, encodeAbiParameters, pad } from "viem";

// CCTP V2 auto-deposit onramp primitives (viem-native mirror of the
// @benzo/contracts source-chain builder). Kept here so the funded suites can
// burn on a source chain and settle on Fuji without pulling in the hardhat
// toolchain. The hookData layout MUST stay byte-identical to the on-chain
// decoder: abi.encode(address user, uint256 pkX, uint256 pkY).

const HOOK_DATA_ABI = [
	{ name: "user", type: "address" },
	{ name: "pkX", type: "uint256" },
	{ name: "pkY", type: "uint256" },
] as const;

export function encodeOnrampHookData(
	user: `0x${string}`,
	pkX: bigint,
	pkY: bigint,
): Hex {
	return encodeAbiParameters(HOOK_DATA_ABI, [user, pkX, pkY]);
}

export function addressToBytes32(address: `0x${string}`): Hex {
	return pad(address, { size: 32 });
}

// Circle TokenMessengerV2 hook-carrying burn on the source chain.
export const TOKEN_MESSENGER_V2_ABI = [
	{
		type: "function",
		name: "depositForBurnWithHook",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "amount", type: "uint256" },
			{ name: "destinationDomain", type: "uint32" },
			{ name: "mintRecipient", type: "bytes32" },
			{ name: "burnToken", type: "address" },
			{ name: "destinationCaller", type: "bytes32" },
			{ name: "maxFee", type: "uint256" },
			{ name: "minFinalityThreshold", type: "uint32" },
			{ name: "hookData", type: "bytes" },
		],
		outputs: [],
	},
] as const;

// Benzo CCTP auto-deposit router settlement on Fuji.
export const BENZO_ROUTER_ABI = [
	{
		type: "function",
		name: "settleDeposit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "message", type: "bytes" },
			{ name: "attestation", type: "bytes" },
			{ name: "amountPCT", type: "uint256[7]" },
		],
		outputs: [],
	},
] as const;
