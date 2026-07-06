import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv = {
	APP_MASTER_KEY:
		"0000000000000000000000000000000000000000000000000000000000000000",
	BENZONET_RPC_URL: "http://127.0.0.1:9650/ext/bc/test/rpc",
	DATABASE_URL: "postgres://benzo:benzo@127.0.0.1:5432/benzo",
	NODE_ENV: "test",
	OPS_PRIVATE_KEY:
		"0x0000000000000000000000000000000000000000000000000000000000000001",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
	it("rejects CHAIN_ENV=fuji with the BenzoNet chain id", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				BENZONET_CHAIN_ID: "68420",
				CHAIN_ENV: "fuji",
			}),
		).toThrow("BENZONET_CHAIN_ID must be 43113 when CHAIN_ENV=fuji");
	});

	it("rejects CHAIN_ENV=benzonet without the BenzoNet chain id", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				CHAIN_ENV: "benzonet",
			}),
		).toThrow("BENZONET_CHAIN_ID must be 68420 when CHAIN_ENV=benzonet");
	});
});
