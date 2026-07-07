import type { Address } from "viem";
import type { CircuitOperation } from "./circuits.js";
import benzonetDeploymentJson from "./deployments/benzonet.json" with { type: "json" };
import fujiDeploymentJson from "./deployments/fuji.json" with { type: "json" };

export const DEPLOYMENT_NETWORKS = ["fuji", "benzonet"] as const;

export type DeploymentNetwork = (typeof DEPLOYMENT_NETWORKS)[number];
export type DeploymentChainId = 43_113 | 68_420;
export type VerifierDeployments = Record<CircuitOperation, Address>;

export type DeploymentContracts = {
	verifiers: VerifierDeployments;
	Registrar?: Address;
	EncryptedERC?: Address;
	tUSDC?: Address;
	HandleRegistry?: Address;
	InvoiceRegistry?: Address;
	GiftEscrow?: Address;
};

export type Deployments = {
	network: DeploymentNetwork;
	chainId: DeploymentChainId;
	contracts: DeploymentContracts;
};

export const fujiDeployments = fujiDeploymentJson as Deployments;
export const benzonetDeployments = benzonetDeploymentJson as Deployments;

export const deploymentsByNetwork = {
	fuji: fujiDeployments,
	benzonet: benzonetDeployments,
} as const satisfies Record<DeploymentNetwork, Deployments>;
