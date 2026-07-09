import type { Address } from "viem";
import type { DeploymentTier } from "./tiers.js";

// Circle CCTP V2 config — single source of truth, keyed by deployment tier.
// Every address here is public and was verified on-chain (eth_getCode) before
// being committed; no secrets belong in this file.

/**
 * Canonical Circle CCTP domain IDs. A domain identifies a chain *family* to the
 * protocol and is identical on testnet and mainnet (e.g. Avalanche Fuji and the
 * Avalanche C-Chain are both domain 1). Source: Circle CCTP V2 docs.
 */
export const CCTP_DOMAINS = {
	ethereum: 0,
	avalanche: 1,
	optimism: 2,
	arbitrum: 3,
	base: 6,
} as const;

export type CctpChain = keyof typeof CCTP_DOMAINS;
export type CctpDomain = (typeof CCTP_DOMAINS)[CctpChain];

export type CctpProtocolConfig = {
	/** TokenMessengerV2 — same address on every EVM chain within the tier. */
	tokenMessenger: Address;
	/** MessageTransmitterV2 — same address on every EVM chain within the tier. */
	messageTransmitter: Address;
	/** Circle Iris attestation-service base URL for this tier. */
	attestationApiBase: string;
};

/**
 * CCTP V2 protocol addresses keyed by deployment tier. Circle deploys the V2
 * contracts at the SAME address on every supported EVM chain, so one per-tier
 * record covers every source chain. All four contract addresses were verified
 * on-chain via eth_getCode — testnet on Fuji/Sepolia/Base Sepolia, mainnet on
 * the Avalanche C-Chain — before being committed.
 */
export const CCTP_PROTOCOL: Record<DeploymentTier, CctpProtocolConfig> = {
	staging: {
		tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
		messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
		attestationApiBase: "https://iris-api-sandbox.circle.com",
	},
	production: {
		tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
		messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
		attestationApiBase: "https://iris-api.circle.com",
	},
};

export type CctpStablecoinSymbol = "USDC" | "EURC";

export type CctpSourceToken = {
	symbol: CctpStablecoinSymbol;
	address: Address;
	decimals: number;
};

export type CctpSourceChain = {
	chain: CctpChain;
	domain: CctpDomain;
	rpcUrl: string;
	tokens: Partial<Record<CctpStablecoinSymbol, CctpSourceToken>>;
};

/**
 * Source-chain registry keyed by tier. A "source chain" is any CCTP domain a
 * user can bridge USDC/EURC *from* into Benzo. EURC is only issued on Ethereum,
 * Base, and Avalanche — Arbitrum and Optimism carry USDC only.
 *
 * Both tiers are populated. Every `staging` (testnet) address was confirmed
 * on-chain by the team; every `production` (mainnet) address is a canonical
 * Circle native-USDC / EURC token that bridges into Benzo's Avalanche C-Chain
 * eERC converter (Avalanche USDC 0xB97EF9Ef…, EURC 0xC891EB4c…).
 */
export const CCTP_SOURCE_CHAINS: Record<
	DeploymentTier,
	Partial<Record<CctpChain, CctpSourceChain>>
> = {
	staging: {
		ethereum: {
			chain: "ethereum",
			domain: CCTP_DOMAINS.ethereum,
			rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
			tokens: {
				USDC: {
					symbol: "USDC",
					address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
					decimals: 6,
				},
				EURC: {
					symbol: "EURC",
					address: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4",
					decimals: 6,
				},
			},
		},
		base: {
			chain: "base",
			domain: CCTP_DOMAINS.base,
			rpcUrl: "https://sepolia.base.org",
			tokens: {
				USDC: {
					symbol: "USDC",
					address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					decimals: 6,
				},
				EURC: {
					symbol: "EURC",
					address: "0x808456652fdb597867f38412077A9182bf77359F",
					decimals: 6,
				},
			},
		},
		arbitrum: {
			chain: "arbitrum",
			domain: CCTP_DOMAINS.arbitrum,
			rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
			tokens: {
				// Arbitrum Sepolia carries USDC only — no Circle EURC issuance.
				USDC: {
					symbol: "USDC",
					address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
					decimals: 6,
				},
			},
		},
		optimism: {
			chain: "optimism",
			domain: CCTP_DOMAINS.optimism,
			rpcUrl: "https://sepolia.optimism.io",
			tokens: {
				// OP Sepolia carries USDC only — no Circle EURC issuance.
				USDC: {
					symbol: "USDC",
					address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
					decimals: 6,
				},
			},
		},
		avalanche: {
			chain: "avalanche",
			domain: CCTP_DOMAINS.avalanche,
			rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
			tokens: {
				USDC: {
					symbol: "USDC",
					address: "0x5425890298aed601595a70AB815c96711a31Bc65",
					decimals: 6,
				},
				EURC: {
					symbol: "EURC",
					address: "0x5E44db7996c682E92a960b65AC713a54AD815c6B",
					decimals: 6,
				},
			},
		},
	},
	// Mainnet source chains. USDC on every domain routes to Avalanche USDC; EURC is
	// only issued on Ethereum + Base and routes to Avalanche EURC. Addresses are
	// Circle's canonical native-token deployments (checksum-verified).
	production: {
		ethereum: {
			chain: "ethereum",
			domain: CCTP_DOMAINS.ethereum,
			rpcUrl: "https://ethereum-rpc.publicnode.com",
			tokens: {
				USDC: {
					symbol: "USDC",
					address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
					decimals: 6,
				},
				EURC: {
					symbol: "EURC",
					address: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
					decimals: 6,
				},
			},
		},
		base: {
			chain: "base",
			domain: CCTP_DOMAINS.base,
			rpcUrl: "https://mainnet.base.org",
			tokens: {
				USDC: {
					symbol: "USDC",
					address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
					decimals: 6,
				},
				EURC: {
					symbol: "EURC",
					address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
					decimals: 6,
				},
			},
		},
		arbitrum: {
			chain: "arbitrum",
			domain: CCTP_DOMAINS.arbitrum,
			rpcUrl: "https://arb1.arbitrum.io/rpc",
			tokens: {
				// Arbitrum One carries native USDC only — no Circle EURC issuance.
				USDC: {
					symbol: "USDC",
					address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
					decimals: 6,
				},
			},
		},
		optimism: {
			chain: "optimism",
			domain: CCTP_DOMAINS.optimism,
			rpcUrl: "https://mainnet.optimism.io",
			tokens: {
				// OP Mainnet carries native USDC only — no Circle EURC issuance.
				USDC: {
					symbol: "USDC",
					address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
					decimals: 6,
				},
			},
		},
	},
};

/**
 * Resolve the CCTP protocol wiring for a deployment tier: the shared
 * TokenMessengerV2 / MessageTransmitterV2 addresses plus the attestation API
 * base every source chain in that tier uses.
 */
export function getCctpConfig(tier: DeploymentTier): CctpProtocolConfig {
	return CCTP_PROTOCOL[tier];
}
