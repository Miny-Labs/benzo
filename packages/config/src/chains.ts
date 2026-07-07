import { defineChain } from "viem";

export const FUJI_CHAIN_ID = 43_113;
export const BENZONET_CHAIN_ID = 68_420;
export const BENZONET_BLOCKCHAIN_ID =
	"21iisL1nkpM2AauUadAz7p1gK3waRBZLEJme3LU3gsWpaxy792";
export const BENZONET_RPC_PATH = `/ext/bc/${BENZONET_BLOCKCHAIN_ID}/rpc`;
export const BENZONET_LOCAL_RPC_URL = `http://127.0.0.1:9650${BENZONET_RPC_PATH}`;

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
			http: [BENZONET_LOCAL_RPC_URL],
		},
	},
	testnet: true,
});

export const benzoChains = [fuji, benzonet] as const;
