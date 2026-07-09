import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadDeploymentRegistry } from "../src/deployment-manifest.js";

// Regression: the token registry must resolve from BOTH manifest shapes — the
// canonical nested `contracts.eercConverter.*` (contracts/deployments/*.json)
// and the flat `contracts.{EncryptedERC,Registrar,tokens}` shape shipped by
// @benzo/config. A mismatch previously yielded an empty registry, which
// silently disabled treasury funding + payroll (deposit -> 503).

const EERC = "0x9E16eD3B799541B4929f7E2014904C65E81035b1";
const REGISTRAR = "0x9a63FEa9851097DBAf3757b636217fdde50ABaF0";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const EURC = "0x5E44db7996c682E92a960b65AC713a54AD815c6B";

const tokens = {
	USDC: { address: USDC, decimals: 6, tokenId: 1, symbol: "USDC" },
	EURC: { address: EURC, decimals: 6, tokenId: 2, symbol: "EURC" },
};

const nestedManifest = {
	network: "fuji",
	chainId: 43113,
	contracts: {
		handleRegistry: "0xC74EcCDE4D9A1F48D560de9A96521D28D58B474b",
		eercConverter: {
			encryptedERC: { address: EERC },
			registrar: { address: REGISTRAR },
			tokens,
		},
	},
};

const flatManifest = {
	network: "fuji",
	chainId: 43113,
	tier: "staging",
	contracts: {
		Registrar: REGISTRAR,
		EncryptedERC: EERC,
		tokens,
		HandleRegistry: "0xC74EcCDE4D9A1F48D560de9A96521D28D58B474b",
	},
};

const dir = mkdtempSync(path.join(tmpdir(), "benzo-manifest-"));
const write = (name: string, obj: unknown): string => {
	const p = path.join(dir, name);
	writeFileSync(p, JSON.stringify(obj));
	return p;
};

afterAll(() => {
	// temp dir is left for the OS to reap; nothing sensitive written.
});

describe("loadDeploymentRegistry token/address resolution", () => {
	it("resolves tokens + addresses from the nested eercConverter schema", () => {
		const registry = loadDeploymentRegistry({
			chainEnv: "fuji",
			chainId: 43113,
			manifestPath: write("nested.json", nestedManifest),
		});

		expect(registry.encryptedErcAddress).toBe(EERC.toLowerCase());
		expect(registry.registrarAddress).toBe(REGISTRAR.toLowerCase());
		expect(registry.tokens.USDC?.tokenId).toBe(1n);
		expect(registry.tokens.USDC?.address).toBe(USDC.toLowerCase());
		expect(registry.tokens.EURC?.tokenId).toBe(2n);
	});

	it("resolves tokens + addresses from the flat @benzo/config schema", () => {
		const registry = loadDeploymentRegistry({
			chainEnv: "fuji",
			chainId: 43113,
			manifestPath: write("flat.json", flatManifest),
		});

		expect(registry.encryptedErcAddress).toBe(EERC.toLowerCase());
		expect(registry.registrarAddress).toBe(REGISTRAR.toLowerCase());
		expect(registry.handleRegistryAddress).toBe(
			"0xc74eccde4d9a1f48d560de9a96521d28d58b474b",
		);
		expect(registry.tokens.USDC?.tokenId).toBe(1n);
		expect(registry.tokens.USDC?.address).toBe(USDC.toLowerCase());
		expect(registry.tokens.EURC?.tokenId).toBe(2n);
	});
});
