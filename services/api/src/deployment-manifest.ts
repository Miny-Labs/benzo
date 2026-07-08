import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for network → chain/tier facts and for reading the
// deployment manifest jsons under contracts/deployments. Both config.ts (at
// startup) and the chain clients resolve addresses through here so there is
// exactly one manifest-resolution path.

export const CHAIN_ENVS = ["fuji", "benzonet", "avalanche"] as const;
export type ChainEnv = (typeof CHAIN_ENVS)[number];

export const DEPLOYMENT_TIERS = ["staging", "production"] as const;
export type DeploymentTier = (typeof DEPLOYMENT_TIERS)[number];

// Mirrors packages/config/src/tiers.ts, defined locally so the backend never
// takes a runtime dependency on @benzo/config.
export const CHAIN_ID_BY_ENV = {
	fuji: 43_113,
	benzonet: 68_420,
	avalanche: 43_114,
} as const satisfies Record<ChainEnv, number>;

// benzonet stays on the staging tier — mainnet is C-Chain (avalanche) only.
export const NETWORK_TIER = {
	fuji: "staging",
	benzonet: "staging",
	avalanche: "production",
} as const satisfies Record<ChainEnv, DeploymentTier>;

// Sensible per-network RPC defaults. benzonet has no public default — its RPC
// is deployment-specific and must be supplied explicitly rather than silently
// inheriting the Fuji endpoint.
export const DEFAULT_RPC_URL_BY_ENV: Partial<Record<ChainEnv, string>> = {
	fuji: "https://api.avax-test.network/ext/bc/C/rpc",
	avalanche: "https://api.avax.network/ext/bc/C/rpc",
};

// Circle CCTP attestation service base, per tier.
export const ATTESTATION_API_BASE_BY_TIER = {
	staging: "https://iris-api-sandbox.circle.com",
	production: "https://iris-api.circle.com",
} as const satisfies Record<DeploymentTier, string>;

const TESTNET_CHAIN_IDS = new Set<number>([
	CHAIN_ID_BY_ENV.fuji,
	CHAIN_ID_BY_ENV.benzonet,
]);

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;

export function tierForChainEnv(chainEnv: ChainEnv): DeploymentTier {
	return NETWORK_TIER[chainEnv];
}

export function deriveChainEnv(
	chainEnv: ChainEnv | undefined,
	chainId: number,
): ChainEnv {
	if (chainEnv) {
		return chainEnv;
	}

	const match = (Object.keys(CHAIN_ID_BY_ENV) as ChainEnv[]).find(
		(env) => CHAIN_ID_BY_ENV[env] === chainId,
	);

	// Preserve the historical fallback (anything unknown maps to benzonet).
	return match ?? "benzonet";
}

export function resolveRpcUrl(
	chainEnv: ChainEnv,
	envRpcUrl: string | undefined,
): string | undefined {
	return envRpcUrl ?? DEFAULT_RPC_URL_BY_ENV[chainEnv];
}

export function isTestnetChainId(chainId: number): boolean {
	return TESTNET_CHAIN_IDS.has(chainId);
}

export function isTestnetRpcHost(rpcUrl: string): boolean {
	let host: string;

	try {
		host = new URL(rpcUrl).hostname.toLowerCase();
	} catch {
		return false;
	}

	return (
		host.includes("avax-test") ||
		host.includes("testnet") ||
		host.includes("fuji")
	);
}

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
	try {
		const host = new URL(databaseUrl).hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "");
		return LOCAL_DB_HOSTS.has(host);
	} catch {
		return false;
	}
}

export type CctpRegistry = {
	domain: number | null;
	tokenMessenger: string | null;
	messageTransmitter: string | null;
	autoDepositRouter: string | null;
};

export type ManifestTokenEntry = {
	address: string;
	decimals: number;
	tokenId: bigint;
	symbol: string;
};

export type DeploymentRegistry = {
	network: string | null;
	chainId: number | null;
	encryptedErcAddress: string | null;
	registrarAddress: string | null;
	handleRegistryAddress: string | null;
	tokens: Record<string, ManifestTokenEntry>;
	cctp: CctpRegistry | null;
};

const deploymentsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../contracts/deployments",
);

export function resolveManifestPath(
	chainEnv: ChainEnv,
	override?: string,
): string {
	return override ?? path.join(deploymentsDir, `${chainEnv}.json`);
}

// Reads + validates the deployment manifest for a network. A missing manifest
// or a manifest whose network/chainId disagrees with the resolved config is a
// startup-time error — there is intentionally no Fuji fallback.
export function loadDeploymentRegistry(params: {
	chainEnv: ChainEnv;
	chainId: number;
	manifestPath?: string;
}): DeploymentRegistry {
	const manifestPath = resolveManifestPath(params.chainEnv, params.manifestPath);
	let raw: string;

	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			throw new Error(`eerc_manifest_missing:${manifestPath}`);
		}

		throw error;
	}

	let manifest: unknown;

	try {
		manifest = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`eerc_manifest_invalid_json:${manifestPath}:${(error as Error).message}`,
		);
	}

	assertManifestMatches(
		manifest,
		params.chainEnv,
		params.chainId,
		manifestPath,
	);

	return extractRegistry(manifest);
}

function assertManifestMatches(
	manifest: unknown,
	chainEnv: ChainEnv,
	chainId: number,
	manifestPath: string,
): void {
	// Require network + chainId — a manifest missing them must fail fast rather
	// than silently pass (this drives on-chain address resolution for real txs,
	// and there is intentionally no fallback).
	const network = readStringPath(manifest, ["network"]);

	if (!network) {
		throw new Error(`eerc_manifest_missing_network:${manifestPath}`);
	}
	if (network !== chainEnv) {
		throw new Error(
			`eerc_manifest_network_mismatch:${manifestPath}:${network}:${chainEnv}`,
		);
	}

	const manifestChainId = readNumberPath(manifest, ["chainId"]);

	if (manifestChainId === null) {
		throw new Error(`eerc_manifest_missing_chain_id:${manifestPath}`);
	}
	if (manifestChainId !== chainId) {
		throw new Error(
			`eerc_manifest_chain_id_mismatch:${manifestPath}:${manifestChainId}:${chainId}`,
		);
	}
}

function extractRegistry(manifest: unknown): DeploymentRegistry {
	const converter = ["contracts", "eercConverter"];

	return {
		network: readStringPath(manifest, ["network"]),
		chainId: readNumberPath(manifest, ["chainId"]),
		encryptedErcAddress: normalizeMaybeAddress(
			readStringPath(manifest, [...converter, "encryptedERC", "address"]),
		),
		registrarAddress: normalizeMaybeAddress(
			readStringPath(manifest, [...converter, "registrar", "address"]),
		),
		handleRegistryAddress: normalizeMaybeAddress(
			readStringPath(manifest, ["contracts", "handleRegistry"]),
		),
		tokens: extractTokens(readValuePath(manifest, [...converter, "tokens"])),
		cctp: extractCctp(readValuePath(manifest, ["contracts", "cctp"])),
	};
}

function extractTokens(value: unknown): Record<string, ManifestTokenEntry> {
	if (!value || typeof value !== "object") {
		return {};
	}

	const tokens: Record<string, ManifestTokenEntry> = {};

	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		const address = normalizeMaybeAddress(readStringPath(entry, ["address"]));
		const decimals = readNumberPath(entry, ["decimals"]);
		const tokenId = readNumberPath(entry, ["tokenId"]);

		if (address && decimals !== null && tokenId !== null) {
			tokens[key] = {
				address,
				decimals,
				tokenId: BigInt(tokenId),
				symbol: readStringPath(entry, ["symbol"]) ?? key,
			};
		}
	}

	return tokens;
}

function extractCctp(value: unknown): CctpRegistry | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	return {
		domain: readNumberPath(value, ["domain"]),
		tokenMessenger: normalizeMaybeAddress(
			readStringPath(value, ["tokenMessenger"]),
		),
		messageTransmitter: normalizeMaybeAddress(
			readStringPath(value, ["messageTransmitter"]),
		),
		autoDepositRouter: normalizeMaybeAddress(
			readStringPath(value, ["autoDepositRouter"]),
		),
	};
}

function normalizeMaybeAddress(value: string | null): string | null {
	if (value && evmAddressPattern.test(value)) {
		return value.toLowerCase();
	}

	return null;
}

function readValuePath(value: unknown, keys: string[]): unknown {
	let cursor = value;

	for (const key of keys) {
		if (!cursor || typeof cursor !== "object" || !(key in cursor)) {
			return null;
		}

		cursor = (cursor as Record<string, unknown>)[key];
	}

	return cursor;
}

function readStringPath(value: unknown, keys: string[]): string | null {
	const resolved = readValuePath(value, keys);
	return typeof resolved === "string" ? resolved : null;
}

function readNumberPath(value: unknown, keys: string[]): number | null {
	const resolved = readValuePath(value, keys);
	return typeof resolved === "number" ? resolved : null;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
