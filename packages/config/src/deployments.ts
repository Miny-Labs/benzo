import type { Address } from "viem";
import type { CircuitOperation } from "./circuits.js";
import type { DeploymentTier } from "./tiers.js";
import avalancheDeploymentJson from "./deployments/avalanche.json" with { type: "json" };
import benzonetDeploymentJson from "./deployments/benzonet.json" with { type: "json" };
import fujiDeploymentJson from "./deployments/fuji.json" with { type: "json" };

export const DEPLOYMENT_NETWORKS = ["fuji", "benzonet", "avalanche"] as const;

export type DeploymentNetwork = (typeof DEPLOYMENT_NETWORKS)[number];
export type DeploymentChainId = 43_113 | 68_420 | 43_114;
export type VerifierDeployments = Record<CircuitOperation, Address>;

export type DeploymentContracts = {
	verifiers: VerifierDeployments;
	Registrar?: Address;
	EncryptedERC?: Address;
	tokens?: Record<
		string,
		{ address: Address; decimals: number; tokenId: number; symbol: string }
	>;
	/**
	 * @deprecated Migration alias for the wrapped TestUSDC address. Superseded by
	 * `tokens`; kept so existing consumers keep resolving the wrapped token until
	 * every manifest is migrated to the `tokens` map.
	 */
	tUSDC?: Address;
	HandleRegistry?: Address;
	InvoiceRegistry?: Address;
	GiftEscrow?: Address;
};

export type Deployments = {
	network: DeploymentNetwork;
	chainId: DeploymentChainId;
	tier: DeploymentTier;
	/**
	 * True for a manifest that is wired (tier + chainId) but not yet deployed —
	 * its contract addresses are zero-address placeholders (e.g. avalanche mainnet
	 * before the cutover). Guard with {@link assertLiveDeployment} before using any
	 * address from it so a not-yet-deployed network never resolves to address(0).
	 */
	placeholder?: boolean;
	contracts: DeploymentContracts;
};

export const fujiDeployments = fujiDeploymentJson as Deployments;
export const benzonetDeployments = benzonetDeploymentJson as Deployments;
export const avalancheDeployments = avalancheDeploymentJson as Deployments;

export const deploymentsByNetwork = {
	fuji: fujiDeployments,
	benzonet: benzonetDeployments,
	avalanche: avalancheDeployments,
} as const satisfies Record<DeploymentNetwork, Deployments>;

/**
 * A placeholder deployment is wired (tier + chainId) but has no deployed
 * contracts yet — its addresses are zero-address stand-ins.
 */
export function isPlaceholderDeployment(deployment: Deployments): boolean {
	return deployment.placeholder === true;
}

/**
 * Returns the deployment for `network`, throwing if it is a placeholder. Use
 * this instead of reading `deploymentsByNetwork[network]` directly whenever you
 * will actually instantiate or call a contract, so a not-yet-deployed network
 * (e.g. avalanche mainnet before the cutover) fails loudly instead of pointing
 * callers at address(0).
 */
export function assertLiveDeployment(network: DeploymentNetwork): Deployments {
	const deployment = deploymentsByNetwork[network];
	if (isPlaceholderDeployment(deployment)) {
		throw new Error(
			`${network} deployment is a placeholder (contracts not deployed yet) — not a live target`,
		);
	}
	return deployment;
}
