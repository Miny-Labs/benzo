import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CORS_ORIGINS, loadConfig } from "../src/config.js";

const baseEnv = {
	APP_MASTER_KEY:
		"0000000000000000000000000000000000000000000000000000000000000000",
	BENZONET_RPC_URL: "http://127.0.0.1:9650/ext/bc/test/rpc",
	DATABASE_URL: "postgres://benzo:benzo@127.0.0.1:5432/benzo",
	NODE_ENV: "test",
	OPS_PRIVATE_KEY:
		"0x0000000000000000000000000000000000000000000000000000000000000001",
} satisfies NodeJS.ProcessEnv;

const deploymentsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../contracts/deployments",
);
const benzonetManifestPath = path.join(deploymentsDir, "benzonet.json");
const fujiManifestPath = path.join(deploymentsDir, "fuji.json");

// A fully-valid Avalanche mainnet (production-tier) environment: hardened
// NODE_ENV, non-local DB, mainnet RPC + chain id. Individual tests point the
// deployment manifest at the wrong (Fuji) addresses to prove config rejects it.
const avalancheEnv = {
	API_DOMAIN: "api.benzo.space",
	BENZONET_CHAIN_ID: "43114",
	BENZONET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
	CHAIN_ENV: "avalanche",
	DATABASE_URL: "postgres://benzo:secret@db.prod.example:5432/benzo",
	NODE_ENV: "production",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
	it("uses the default CORS origins when CORS_ORIGINS is unset", () => {
		expect(loadConfig(baseEnv).corsOrigins).toEqual(DEFAULT_CORS_ORIGINS);
	});

	it("allows RELAYER_PRIVATE_KEY to be omitted", () => {
		expect(loadConfig(baseEnv).relayerPrivateKey).toBeUndefined();
	});

	it("parses comma-separated CORS origins", () => {
		expect(
			loadConfig({
				...baseEnv,
				CORS_ORIGINS:
					" https://wallet.example ,http://localhost:5173, https://wallet.example ",
			}).corsOrigins,
		).toEqual(["https://wallet.example", "http://localhost:5173"]);
	});

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

	it("resolves eERC addresses + tier from the fuji deployment manifest", () => {
		const config = loadConfig(baseEnv);

		expect(config.chainEnv).toBe("fuji");
		expect(config.tier).toBe("staging");
		expect(config.benzonetChainId).toBe(43_113);
		// Sourced from contracts/deployments/fuji.json → eercConverter.*
		expect(config.eercEncryptedErcAddress).toBe(
			"0x9e16ed3b799541b4929f7e2014904c65e81035b1",
		);
		expect(config.eercRegistrarAddress).toBe(
			"0x9a63fea9851097dbaf3757b636217fdde50abaf0",
		);
		// USDC tokenId from the manifest tokens map.
		expect(config.payrollTokenId).toBe(1n);
	});

	it("prefers explicit address env overrides over the manifest", () => {
		const config = loadConfig({
			...baseEnv,
			EERC_ENCRYPTED_ERC_ADDRESS:
				"0x1111111111111111111111111111111111111111",
			EERC_REGISTRAR_ADDRESS: "0x2222222222222222222222222222222222222222",
			PAYROLL_TOKEN_ID: "7",
		});

		expect(config.eercEncryptedErcAddress).toBe(
			"0x1111111111111111111111111111111111111111",
		);
		expect(config.eercRegistrarAddress).toBe(
			"0x2222222222222222222222222222222222222222",
		);
		expect(config.payrollTokenId).toBe(7n);
	});

	it("passes CCTP config through from the manifest, by tier", () => {
		const config = loadConfig(baseEnv);

		expect(config.cctpDomain).toBe(1);
		expect(config.cctpDestDomain).toBe(1);
		expect(config.cctpTokenMessenger).toBe(
			"0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa",
		);
		expect(config.cctpMessageTransmitter).toBe(
			"0xe737e5cebeeba77efe34d4aa090756590b1ce275",
		);
		// staging tier → Circle sandbox attestation service.
		expect(config.cctpAttestationApiBase).toBe(
			"https://iris-api-sandbox.circle.com",
		);
		// fuji manifest now wires the deployed BenzoCCTPRouter (#119).
		expect(config.autoDepositRouterAddress).toBe(
			"0x4b4f0dc760115db356cdfa89b4950e3418a3d98d",
		);
	});

	it("prefers CCTP env overrides over resolved defaults", () => {
		const config = loadConfig({
			...baseEnv,
			BENZO_CCTP_ROUTER_ADDRESS:
				"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			IRIS_API_BASE: "https://iris.example.test",
		});

		expect(config.autoDepositRouterAddress).toBe(
			"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		expect(config.cctpAttestationApiBase).toBe("https://iris.example.test");
	});

	it("parses dedicated onramp poller controls", () => {
		const config = loadConfig({
			...baseEnv,
			ONRAMP_POLLER_ENABLED: "false",
			ONRAMP_POLL_CRON: "*/30 * * * * *",
		});

		expect(config.onrampPollerEnabled).toBe(false);
		expect(config.onrampPollCron).toBe("*/30 * * * * *");
	});

	it.each([
		"0x0000000000000000000000000000000000000000000000000000000000000000",
		`0x${"ff".repeat(32)}`,
	])("rejects invalid relayer private key %s", (key) => {
		expect(() =>
			loadConfig({
				...baseEnv,
				RELAYER_PRIVATE_KEY: key,
			}),
		).toThrow("RELAYER_PRIVATE_KEY must be a valid secp256k1 private key");
	});

	it("rejects a CCTP destination domain other than Avalanche", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				CCTP_DEST_DOMAIN: "0",
			}),
		).toThrow("CCTP_DEST_DOMAIN must be 1");
	});

	it("throws (no Fuji fallback) when neither the manifest nor an env override resolves an address", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				EERC_DEPLOYMENT_MANIFEST: path.join(deploymentsDir, "does-not-exist.json"),
			}),
		).toThrow("eerc_encrypted_erc_unresolved");
	});

	it("resolves from env overrides when the manifest file is absent (deployed image)", () => {
		// The deployed API image does not bundle contracts/deployments, so the
		// addresses come from EERC_*_ADDRESS and an absent manifest must still boot.
		const config = loadConfig({
			...baseEnv,
			EERC_DEPLOYMENT_MANIFEST: path.join(deploymentsDir, "does-not-exist.json"),
			EERC_ENCRYPTED_ERC_ADDRESS:
				"0x9e16ed3b799541b4929f7e2014904c65e81035b1",
			EERC_REGISTRAR_ADDRESS: "0x9a63fea9851097dbaf3757b636217fdde50abaf0",
		});

		expect(config.eercEncryptedErcAddress).toBe(
			"0x9e16ed3b799541b4929f7e2014904c65e81035b1",
		);
		expect(config.eercRegistrarAddress).toBe(
			"0x9a63fea9851097dbaf3757b636217fdde50abaf0",
		);
		// No manifest → payroll tokenId falls back to the default (USDC=tokenId 1).
		expect(config.payrollTokenId).toBe(1n);
	});

	it("fails fast when the manifest network disagrees with CHAIN_ENV", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				CHAIN_ENV: "fuji",
				EERC_DEPLOYMENT_MANIFEST: benzonetManifestPath,
			}),
		).toThrow("eerc_manifest_network_mismatch");
	});

	it("allows NODE_ENV=production on a staging-tier network (hardened staging)", () => {
		// The live staging API runs NODE_ENV=production against Fuji; that must boot.
		const config = loadConfig({
			...baseEnv,
			API_DOMAIN: "api.benzo.space",
			CHAIN_ENV: "fuji",
			DATABASE_URL: "postgres://benzo:secret@db.prod.example:5432/benzo",
			NODE_ENV: "production",
		});
		expect(config.tier).toBe("staging");
		expect(config.nodeEnv).toBe("production");
	});

	it("requires NODE_ENV=production on a production-tier network", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				API_DOMAIN: "api.benzo.space",
				BENZONET_CHAIN_ID: "43114",
				BENZONET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
				CHAIN_ENV: "avalanche",
				DATABASE_URL: "postgres://benzo:secret@db.prod.example:5432/benzo",
				NODE_ENV: "test",
			}),
		).toThrow("requires NODE_ENV=production");
	});

	it("rejects a local DATABASE_URL in production", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				API_DOMAIN: "api.benzo.space",
				BENZONET_CHAIN_ID: "43114",
				BENZONET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
				CHAIN_ENV: "avalanche",
				// baseEnv DATABASE_URL points at 127.0.0.1 → rejected in production.
				NODE_ENV: "production",
			}),
		).toThrow("must not point at a local database");
	});

	it("rejects a testnet RPC host on a production-tier network", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				BENZONET_CHAIN_ID: "43114",
				BENZONET_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
				CHAIN_ENV: "avalanche",
			}),
		).toThrow("must not use a testnet RPC host");
	});

	it("asserts CHAIN_ENV=avalanche implies chain id 43114", () => {
		expect(() =>
			loadConfig({
				...baseEnv,
				CHAIN_ENV: "avalanche",
			}),
		).toThrow("BENZONET_CHAIN_ID must be 43114 when CHAIN_ENV=avalanche");
	});

	it("rejects CHAIN_ENV=avalanche pointed at the Fuji deployment manifest (Fuji addresses)", () => {
		// A production-tier mainnet env that resolves its on-chain addresses from
		// the Fuji manifest must fail fast rather than run mainnet against testnet
		// contracts.
		expect(() =>
			loadConfig({
				...baseEnv,
				...avalancheEnv,
				EERC_DEPLOYMENT_MANIFEST: fujiManifestPath,
			}),
		).toThrow("eerc_manifest_network_mismatch");
	});
});
