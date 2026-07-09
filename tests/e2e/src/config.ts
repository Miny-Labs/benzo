import {
	type CctpChain,
	type CctpProtocolConfig,
	CCTP_SOURCE_CHAINS,
	type CctpSourceChain,
	type DeploymentNetwork,
	type Deployments,
	type StablecoinInfo,
	assertLiveDeployment,
	avalanche,
	benzonet,
	fuji,
	getCctpConfig,
	stablecoinsForNetwork,
	tierForNetwork,
} from "@benzo/config";
import type { Chain } from "viem";
import { envOr } from "./env.js";

// Targets Benzo actually runs funded e2e against. Mainnet (avalanche) is
// intentionally excluded — TIER 2 is staging-only, so a manifest swap to
// production never drags the live suites onto the C-Chain by accident.
export const E2E_TARGETS = ["fuji", "benzonet"] as const;
export type E2ETarget = (typeof E2E_TARGETS)[number];

const VIEM_CHAINS: Record<DeploymentNetwork, Chain> = {
	fuji,
	benzonet,
	avalanche,
};

export type E2EConfig = {
	target: E2ETarget;
	network: DeploymentNetwork;
	chainId: number;
	tier: "staging" | "production";
	chain: Chain;
	rpcUrl: string;
	explorerBaseUrl: string | undefined;
	apiBaseUrl: string | undefined;
	deployment: Deployments;
	stablecoins: Partial<Record<"USDC" | "EURC", StablecoinInfo>>;
	cctp: CctpProtocolConfig | undefined;
	cctpSourceChains: Partial<Record<CctpChain, CctpSourceChain>>;
};

function resolveTarget(explicit?: E2ETarget): E2ETarget {
	if (explicit !== undefined) {
		return explicit;
	}
	const raw = envOr("BENZO_E2E_TARGET", "fuji");
	if ((E2E_TARGETS as readonly string[]).includes(raw)) {
		return raw as E2ETarget;
	}
	throw new Error(
		`Unknown BENZO_E2E_TARGET "${raw}"; expected one of ${E2E_TARGETS.join(", ")}`,
	);
}

function rpcUrlFor(target: E2ETarget, chain: Chain): string {
	// Per-target override, else the viem chain's default endpoint. BenzoNet has
	// no public RPC, so a BenzoNet URL must be supplied for that target. Accept
	// both the namespaced BENZO_E2E_* names documented in .env.example and the
	// bare names for parity with the contracts deploy config.
	const override =
		envOr(
			target === "fuji" ? "BENZO_E2E_FUJI_RPC_URL" : "BENZO_E2E_BENZONET_RPC_URL",
			"",
		) || envOr(target === "fuji" ? "FUJI_RPC_URL" : "BENZONET_RPC_URL", "");
	if (override !== "") {
		return override;
	}
	// BenzoNet has no public RPC — surface an actionable error rather than a
	// confusing downstream failure against a nonexistent default endpoint.
	if (target === "benzonet") {
		throw new Error(
			"BenzoNet has no public RPC; set BENZO_E2E_BENZONET_RPC_URL (or BENZONET_RPC_URL) to run benzonet suites.",
		);
	}
	return chain.rpcUrls.default.http[0];
}

/**
 * Build the fully config-driven target descriptor for the funded suites. Every
 * address is resolved from @benzo/config (deployment manifest, STABLECOINS, CCTP
 * tables) — there are NO 0x literals here or in any suite body. Swapping the
 * target (or the underlying manifest for mainnet) reroutes every suite.
 */
export function loadE2EConfig(explicitTarget?: E2ETarget): E2EConfig {
	const target = resolveTarget(explicitTarget);
	const network: DeploymentNetwork = target;
	const deployment = assertLiveDeployment(network);
	const tier = tierForNetwork(network);
	const chain = VIEM_CHAINS[network];

	return {
		target,
		network,
		chainId: deployment.chainId,
		tier,
		chain,
		rpcUrl: rpcUrlFor(target, chain),
		explorerBaseUrl: chain.blockExplorers?.default.url,
		apiBaseUrl: envOr("BENZO_API_BASE_URL", "") || undefined,
		deployment,
		stablecoins: stablecoinsForNetwork(network),
		// BenzoNet is not a CCTP domain, so it has no protocol wiring or sources.
		cctp: network === "benzonet" ? undefined : getCctpConfig(tier),
		cctpSourceChains: network === "benzonet" ? {} : CCTP_SOURCE_CHAINS[tier],
	};
}
