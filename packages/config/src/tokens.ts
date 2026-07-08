import type { Address } from "viem";
import type { DeploymentNetwork } from "./deployments.js";

// Canonical Circle stablecoin registry. Addresses are the real Circle-issued
// USDC/EURC token contracts on each network; benzonet is intentionally empty
// because it wraps a locally deployed TestUSDC whose address lives in the
// deployment manifest, not a Circle token.
export type StablecoinSymbol = "USDC" | "EURC";

export type StablecoinInfo = {
	address: Address;
	decimals: number;
	symbol: StablecoinSymbol;
};

export const STABLECOINS: Record<
	DeploymentNetwork,
	Partial<Record<StablecoinSymbol, StablecoinInfo>>
> = {
	fuji: {
		USDC: {
			address: "0x5425890298aed601595a70AB815c96711a31Bc65",
			decimals: 6,
			symbol: "USDC",
		},
		EURC: {
			address: "0x5E44db7996c682E92a960b65AC713a54AD815c6B",
			decimals: 6,
			symbol: "EURC",
		},
	},
	// benzonet wraps a deployed TestUSDC (see the manifest tUSDC alias), not a
	// Circle token — so there is no canonical Circle stablecoin to register here.
	benzonet: {},
	avalanche: {
		USDC: {
			address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
			decimals: 6,
			symbol: "USDC",
		},
		EURC: {
			address: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD",
			decimals: 6,
			symbol: "EURC",
		},
	},
};

export function stablecoinsForNetwork(
	network: DeploymentNetwork,
): Partial<Record<StablecoinSymbol, StablecoinInfo>> {
	return STABLECOINS[network];
}

export function getStablecoin(
	network: DeploymentNetwork,
	symbol: StablecoinSymbol,
): StablecoinInfo | undefined {
	return STABLECOINS[network][symbol];
}
