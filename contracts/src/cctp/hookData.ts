import {
	type Address,
	type Hex,
	decodeAbiParameters,
	encodeAbiParameters,
} from "viem";

// CCTP V2 hookData codec for Benzo auto-deposit.
//
// INVARIANT: the encoding is exactly `abi.encode(address user, uint256 pkX,
// uint256 pkY)` — three head-only 32-byte words, no dynamic tail. This makes the
// bytes byte-identical to the on-chain `CctpMessageV2` decoder that #108 adds
// (Solidity: `abi.decode(hookData, (address, uint256, uint256))`). Do NOT change
// this tuple layout without updating that on-chain decoder in the same PR.
const HOOK_DATA_ABI = [
	{ name: "user", type: "address" },
	{ name: "pkX", type: "uint256" },
	{ name: "pkY", type: "uint256" },
] as const;

export type CctpHookData = {
	user: Address;
	pkX: bigint;
	pkY: bigint;
};

/**
 * ABI-encode the CCTP auto-deposit hookData tuple `(address, uint256, uint256)`.
 * Always returns a 96-byte (3 × 32) hex string.
 */
export function encodeHookData({ user, pkX, pkY }: CctpHookData): Hex {
	return encodeAbiParameters(HOOK_DATA_ABI, [user, pkX, pkY]);
}

/**
 * Inverse of {@link encodeHookData}: decode the `(address, uint256, uint256)`
 * hookData tuple back into `{ user, pkX, pkY }`.
 */
export function decodeHookData(hex: Hex): CctpHookData {
	const [user, pkX, pkY] = decodeAbiParameters(HOOK_DATA_ABI, hex);

	return { user, pkX, pkY };
}
