import { getAddress, type PublicClient } from "viem";
import type { ApiConfig } from "../config.js";

// Read-only destination-chain reader for the onramp. It resolves whether a user
// is eERC-registered on the destination and, if so, their on-chain public key —
// the two facts the quote/intents routes need to build server-authoritative
// hookData and to reject users who cannot receive an auto-deposit.

export type OnrampUserKey = {
	registered: boolean;
	// The user's eERC BabyJubJub public key, or null when not registered.
	publicKey: [bigint, bigint] | null;
};

export type OnrampChainClient = {
	resolveUserKey: (address: string) => Promise<OnrampUserKey>;
};

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
] as const;

export function createOnrampChainClient(
	config: ApiConfig,
	publicClient: PublicClient,
): OnrampChainClient {
	// config.eercRegistrarAddress is resolved from the deployment manifest (or an
	// explicit env override) at startup — see config.ts. There is no second
	// manifest-resolution path here.
	const registrarAddress = getAddress(config.eercRegistrarAddress);

	return {
		async resolveUserKey(address) {
			const user = getAddress(address);
			const registered = await publicClient.readContract({
				abi: registrarAbi,
				address: registrarAddress,
				args: [user],
				functionName: "isUserRegistered",
			});

			if (!registered) {
				return { registered: false, publicKey: null };
			}

			const publicKey = await publicClient.readContract({
				abi: registrarAbi,
				address: registrarAddress,
				args: [user],
				functionName: "getUserPublicKey",
			});

			return {
				registered: true,
				publicKey: [publicKey[0], publicKey[1]],
			};
		},
	};
}
