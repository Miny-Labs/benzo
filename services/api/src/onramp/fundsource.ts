import {
	CCTP_PROTOCOL,
	CCTP_SOURCE_CHAINS,
	type CctpChain,
	type CctpStablecoinSymbol,
	type DeploymentTier,
} from "@benzo/config";
import { type Address, getAddress } from "viem";
import { resolveSourceDomain } from "./domains.js";

// Cross-chain treasury funding source resolver (issue #114). The set of source
// chains, their CCTP domains, and per-chain USDC/EURC availability all come from
// @benzo/config (CCTP_SOURCE_CHAINS + CCTP_PROTOCOL) — the single source of
// truth verified on-chain — so the console can offer exactly the chain/token
// combos Benzo supports and the backend rejects the rest (e.g. EURC on Arbitrum
// or Optimism, which carry USDC only).

export type FundSourceToken = "usdc" | "eurc";

// The console names a source chain (not a raw CCTP domain id); these are the
// keys of CCTP_SOURCE_CHAINS.
export const FUND_SOURCE_CHAINS = [
	"ethereum",
	"avalanche",
	"optimism",
	"arbitrum",
	"base",
] as const satisfies readonly CctpChain[];

export type FundSourceChain = (typeof FUND_SOURCE_CHAINS)[number];

export type ResolvedFundSource = {
	chain: CctpChain;
	domain: number;
	chainId: number;
	token: FundSourceToken;
	// Source-chain USDC/EURC ERC-20 that the funding wallet burns.
	burnToken: Address;
	burnTokenDecimals: number;
	// Source-chain CCTP V2 TokenMessenger (same address on every EVM chain in the
	// tier) the funding wallet calls depositForBurnWithHook on.
	tokenMessenger: Address;
};

export type FundSourceRejection =
	| "unsupported_source_chain"
	| "unsupported_source_token";

export type FundSourceResolution =
	| { ok: true; source: ResolvedFundSource }
	| { ok: false; error: FundSourceRejection };

function tokenSymbol(token: FundSourceToken): CctpStablecoinSymbol {
	return token.toUpperCase() as CctpStablecoinSymbol;
}

/**
 * Resolve the burn wiring for funding an org treasury from `chain` with `token`
 * on the given deployment tier. Returns a typed rejection for an unknown chain
 * (not deployed on this tier) or a token the chain does not carry.
 */
export function resolveTreasuryFundSource(
	tier: DeploymentTier,
	chain: string,
	token: FundSourceToken,
): FundSourceResolution {
	const sourceChain = CCTP_SOURCE_CHAINS[tier][chain as CctpChain];
	if (!sourceChain) {
		return { ok: false, error: "unsupported_source_chain" };
	}

	const sourceToken = sourceChain.tokens[tokenSymbol(token)];
	if (!sourceToken) {
		return { ok: false, error: "unsupported_source_token" };
	}

	// chainId lives in the backend's domain registry (mirrors the @benzo/config
	// domains); the domain we just resolved from config is always known there.
	const resolvedDomain = resolveSourceDomain(tier, sourceChain.domain);
	if (!resolvedDomain) {
		return { ok: false, error: "unsupported_source_chain" };
	}

	return {
		ok: true,
		source: {
			burnToken: getAddress(sourceToken.address),
			burnTokenDecimals: sourceToken.decimals,
			chain: sourceChain.chain,
			chainId: resolvedDomain.chainId,
			domain: sourceChain.domain,
			token,
			tokenMessenger: getAddress(CCTP_PROTOCOL[tier].tokenMessenger),
		},
	};
}
