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
	converterAddress: string | null;
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

// An absent manifest yields this empty registry, so on-chain addresses must then
// come from the EERC_*_ADDRESS env overrides (config throws eerc_*_unresolved when
// they are also absent — still no silent Fuji fallback).
const EMPTY_DEPLOYMENT_REGISTRY: DeploymentRegistry = {
	network: null,
	chainId: null,
	converterAddress: null,
	encryptedErcAddress: null,
	registrarAddress: null,
	handleRegistryAddress: null,
	tokens: {},
	cctp: null,
};

// Reads + validates the deployment manifest for a network. The manifest is
// OPTIONAL at the file level: the deployed API image is built from services/api
// and does not bundle contracts/deployments, so there the addresses come from the
// EERC_*_ADDRESS env overrides and an absent manifest yields an empty registry
// (rather than crashing at boot). A manifest that IS present but has a mismatched
// network/chainId or malformed JSON is still a startup-time error.
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
			return EMPTY_DEPLOYMENT_REGISTRY;
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

// The deployment manifest ships in two shapes. The canonical
// contracts/deployments/*.json nests the converter under
// `contracts.eercConverter` (addresses as `{ address }` objects); the
// @benzo/config-bundled copy is flat (`contracts.EncryptedERC`,
// `contracts.Registrar`, `contracts.tokens` as bare strings/objects). Read each
// field from the nested path first, then fall back to the flat one, so the
// backend resolves the token registry + on-chain addresses regardless of which
// manifest EERC_DEPLOYMENT_MANIFEST points at. A schema mismatch here previously
// yielded an EMPTY token registry, which silently disabled treasury funding /
// payroll (deposit → 503 treasury_token_not_configured).
function extractRegistry(manifest: unknown): DeploymentRegistry {
	const converter = ["contracts", "eercConverter"];
	const converterAddress = normalizeMaybeAddress(
		readFirstStringPath(manifest, [
			[...converter, "encryptedERC", "address"],
			["contracts", "EncryptedERC"],
			["contracts", "encryptedERC"],
		]),
	);

	return {
		network: readStringPath(manifest, ["network"]),
		chainId: readNumberPath(manifest, ["chainId"]),
		converterAddress,
		encryptedErcAddress: converterAddress,
		registrarAddress: normalizeMaybeAddress(
			readFirstStringPath(manifest, [
				[...converter, "registrar", "address"],
				["contracts", "Registrar"],
				["contracts", "registrar"],
			]),
		),
		handleRegistryAddress: normalizeMaybeAddress(
			readFirstStringPath(manifest, [
				["contracts", "handleRegistry"],
				["contracts", "HandleRegistry"],
			]),
		),
		tokens: extractTokens(
			readFirstValuePath(manifest, [
				[...converter, "tokens"],
				["contracts", "tokens"],
			]),
		),
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

// Return the first non-nullish value across candidate paths — lets a single
// field be read from either the nested (eercConverter) or flat manifest shape.
function readFirstValuePath(value: unknown, paths: string[][]): unknown {
	for (const keys of paths) {
		const resolved = readValuePath(value, keys);
		if (resolved !== null && resolved !== undefined) {
			return resolved;
		}
	}

	return null;
}

function readFirstStringPath(value: unknown, paths: string[][]): string | null {
	for (const keys of paths) {
		const resolved = readStringPath(value, keys);
		if (resolved !== null) {
			return resolved;
		}
	}

	return null;
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
