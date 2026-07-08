import { defineChain } from "viem";

export const FUJI_CHAIN_ID = 43_113;
export const AVALANCHE_CHAIN_ID = 43_114;
export const BENZONET_CHAIN_ID = 68_420;
export const BENZONET_BLOCKCHAIN_ID =
	"21iisL1nkpM2AauUadAz7p1gK3waRBZLEJme3LU3gsWpaxy792";
export const BENZONET_RPC_PATH = `/ext/bc/${BENZONET_BLOCKCHAIN_ID}/rpc`;
export const BENZONET_LOCAL_RPC_URL = `http://127.0.0.1:9650${BENZONET_RPC_PATH}`;

// BenzoNet has NO single public RPC — it's reached only through Caddy with a
// per-app path token (rpc.benzonet.<domain>/<app>/<token>), so the URL is both
// deployment- and app-specific. Browser apps MUST supply their own tokened URL
// via wagmi's `transports` rather than relying on this chain's default. The
// default below is the local-node/dev convention; override on the server with
// BENZONET_RPC_URL. (Guarded so it's browser-safe when `process` is absent.)
const benzonetRpcOverride =
	typeof process !== "undefined" ? process.env?.BENZONET_RPC_URL : undefined;
export const BENZONET_DEFAULT_RPC_URL =
	benzonetRpcOverride && benzonetRpcOverride.length > 0
		? benzonetRpcOverride
		: BENZONET_LOCAL_RPC_URL;

export const fuji = defineChain({
	id: FUJI_CHAIN_ID,
	name: "Avalanche Fuji",
	nativeCurrency: {
		decimals: 18,
		name: "Avalanche Fuji AVAX",
		symbol: "AVAX",
	},
	rpcUrls: {
		default: {
			http: ["https://api.avax-test.network/ext/bc/C/rpc"],
		},
	},
	blockExplorers: {
		default: {
			name: "Snowtrace",
			url: "https://testnet.snowtrace.io",
		},
	},
	testnet: true,
});

export const avalanche = defineChain({
	id: AVALANCHE_CHAIN_ID,
	name: "Avalanche C-Chain",
	nativeCurrency: {
		decimals: 18,
		name: "Avalanche",
		symbol: "AVAX",
	},
	rpcUrls: {
		default: {
			http: ["https://api.avax.network/ext/bc/C/rpc"],
		},
	},
	blockExplorers: {
		default: {
			name: "Snowtrace",
			url: "https://snowtrace.io",
		},
	},
	testnet: false,
});

export const benzonet = defineChain({
	id: BENZONET_CHAIN_ID,
	name: "BenzoNet",
	nativeCurrency: {
		decimals: 18,
		name: "Benzo Gas",
		symbol: "BGAS",
	},
	rpcUrls: {
		default: {
			http: [BENZONET_DEFAULT_RPC_URL],
		},
	},
	testnet: true,
});

export const benzoChains = [fuji, benzonet] as const;
