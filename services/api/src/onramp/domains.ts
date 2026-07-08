import type { DeploymentTier } from "../deployment-manifest.js";

// CCTP source-domain registry. A "source domain" is any CCTP domain a user can
// bridge USDC/EURC *from* into Benzo. Circle domain IDs are protocol constants
// that are identical on testnet and mainnet; only the concrete chain id differs
// by tier. This mirrors packages/config/src/cctp.ts (CCTP_DOMAINS +
// CCTP_SOURCE_CHAINS), defined locally so the backend never takes a runtime
// dependency on @benzo/config — the same convention deployment-manifest.ts uses
// for CHAIN_ID_BY_ENV. Destination wiring (router/tokenMessenger/domain) is NOT
// hardcoded here; it always comes from the deployment manifest via config.

export type OnrampToken = "usdc" | "eurc";

export type CctpSourceDomain = {
	chain: string;
	// Concrete chain id per deployment tier (testnet vs mainnet).
	chainIdByTier: Record<DeploymentTier, number>;
	// Circle only issues EURC on Ethereum, Base, and Avalanche; Arbitrum and
	// Optimism carry USDC only.
	tokens: OnrampToken[];
};

export const CCTP_SOURCE_DOMAINS: Record<number, CctpSourceDomain> = {
	0: {
		chain: "ethereum",
		chainIdByTier: { staging: 11_155_111, production: 1 },
		tokens: ["usdc", "eurc"],
	},
	1: {
		chain: "avalanche",
		chainIdByTier: { staging: 43_113, production: 43_114 },
		tokens: ["usdc", "eurc"],
	},
	2: {
		chain: "optimism",
		chainIdByTier: { staging: 11_155_420, production: 10 },
		tokens: ["usdc"],
	},
	3: {
		chain: "arbitrum",
		chainIdByTier: { staging: 421_614, production: 42_161 },
		tokens: ["usdc"],
	},
	6: {
		chain: "base",
		chainIdByTier: { staging: 84_532, production: 8_453 },
		tokens: ["usdc", "eurc"],
	},
};

export type ResolvedSourceDomain = {
	chain: string;
	chainId: number;
	domain: number;
	tokens: OnrampToken[];
};

/**
 * Resolve a CCTP source domain to its concrete chain id for the given tier.
 * Returns null for an unknown domain so callers can reject client input.
 */
export function resolveSourceDomain(
	tier: DeploymentTier,
	domain: number,
): ResolvedSourceDomain | null {
	const entry = CCTP_SOURCE_DOMAINS[domain];

	if (!entry) {
		return null;
	}

	return {
		chain: entry.chain,
		chainId: entry.chainIdByTier[tier],
		domain,
		tokens: entry.tokens,
	};
}
