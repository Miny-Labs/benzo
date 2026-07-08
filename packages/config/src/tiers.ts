// Deployment tiers separate testnet-class networks (staging) from the single
// mainnet C-Chain (production). Import the DeploymentNetwork *type* only so this
// module never creates a runtime import cycle with ./deployments.
import type { DeploymentNetwork } from "./deployments.js";

export const DEPLOYMENT_TIERS = ["staging", "production"] as const;

export type DeploymentTier = (typeof DEPLOYMENT_TIERS)[number];

// benzonet stays on the staging tier — mainnet is C-Chain (avalanche) only.
export const NETWORK_TIER = {
	fuji: "staging",
	benzonet: "staging",
	avalanche: "production",
} as const satisfies Record<DeploymentNetwork, DeploymentTier>;

export function tierForNetwork(network: DeploymentNetwork): DeploymentTier {
	return NETWORK_TIER[network];
}
