import {
	type Address,
	decodeAbiParameters,
	encodeAbiParameters,
	getAddress,
	type Hex,
} from "viem";

// Server-side CCTP hookData codec for Benzo auto-deposit. This MUST stay
// byte-identical to the on-chain decoder and to the shared codec in
// contracts/src/cctp/hookData.ts:
//
//   INVARIANT: abi.encode(address user, uint256 pkX, uint256 pkY) — three
//   head-only 32-byte words, no dynamic tail (Solidity:
//   abi.decode(hookData, (address, uint256, uint256))).
//
// Do NOT change this tuple layout without updating the on-chain decoder and the
// contracts codec in the same PR.
const HOOK_DATA_ABI = [
	{ name: "user", type: "address" },
	{ name: "pkX", type: "uint256" },
	{ name: "pkY", type: "uint256" },
] as const;

export type OnrampHookData = {
	user: Address;
	pkX: bigint;
	pkY: bigint;
};

/**
 * ABI-encode the CCTP auto-deposit hookData tuple `(address, uint256, uint256)`.
 * Always returns a 96-byte (3 × 32) hex string.
 */
export function encodeOnrampHookData({
	user,
	pkX,
	pkY,
}: OnrampHookData): Hex {
	return encodeAbiParameters(HOOK_DATA_ABI, [getAddress(user), pkX, pkY]);
}

/**
 * Inverse of {@link encodeOnrampHookData}: decode the `(address, uint256,
 * uint256)` hookData tuple back into `{ user, pkX, pkY }`.
 */
export function decodeOnrampHookData(hex: Hex): OnrampHookData {
	const [user, pkX, pkY] = decodeAbiParameters(HOOK_DATA_ABI, hex);

	return { user: getAddress(user), pkX, pkY };
}

/**
 * Validate that `hex` decodes to exactly the `expected` tuple. Throws
 * `onramp_hookdata_mismatch` otherwise. Used to defend against a client
 * submitting a hookData that binds a different user/public key than the
 * server-authoritative one.
 */
export function assertOnrampHookDataMatches(
	hex: Hex,
	expected: OnrampHookData,
): void {
	const decoded = decodeOnrampHookData(hex);
	const normalizedUser = getAddress(expected.user);

	if (
		decoded.user !== normalizedUser ||
		decoded.pkX !== expected.pkX ||
		decoded.pkY !== expected.pkY
	) {
		throw new Error("onramp_hookdata_mismatch");
	}
}
