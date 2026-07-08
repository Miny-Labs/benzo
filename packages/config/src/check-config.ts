import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { isAddress } from "viem";
import {
	CIRCUIT_EXTENSIONS,
	type CircuitArtifactManifestEntry,
	CIRCUIT_OPERATIONS,
	circuitArtifactFile,
} from "./circuits.js";
import {
	DEPLOYMENT_NETWORKS,
	type DeploymentContracts,
	type DeploymentNetwork,
	type Deployments,
	deploymentsByNetwork,
} from "./deployments.js";
import { DEPLOYMENT_TIERS, NETWORK_TIER } from "./tiers.js";
import { STABLECOINS } from "./tokens.js";

type JsonObject = Record<string, unknown>;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const circuitManifestDirectory = join(packageRoot, "public", "circuits");
const circuitManifestPath = join(circuitManifestDirectory, "manifest.json");

const failures: string[] = [];

for (const network of DEPLOYMENT_NETWORKS) {
	const deployment = deploymentsByNetwork[network];

	// Tier/chainId consistency is asserted for every network, including
	// placeholder mainnet manifests that have no deployed addresses yet.
	validateDeploymentTier(network, deployment);

	// A source manifest flagged `"placeholder": true` (e.g. avalanche/mainnet
	// before the flip) has no deployed contracts, so we skip the address-validity
	// and compact-match checks for it rather than fabricate verifier addresses.
	if (isPlaceholderManifest(network)) {
		continue;
	}

	validateDeploymentAddresses(network, deployment);
	assertDeploymentMatchesSource(network, deployment);
}

validateStablecoins();

verifyCircuitManifestIfPresent();

if (failures.length > 0) {
	console.error("Config check failed:");
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log(
	`Verified ${DEPLOYMENT_NETWORKS.length} deployment manifests from packages/config/src/deployments.`,
);

if (existsSync(circuitManifestPath)) {
	console.log(
		`Verified circuit artifact hashes from ${relative(repoRoot, circuitManifestPath)}.`,
	);
} else {
	console.log(
		`Skipped circuit artifact hash check; ${relative(repoRoot, circuitManifestPath)} is not present.`,
	);
}

function validateDeploymentAddresses(
	network: DeploymentNetwork,
	deployment: Deployments,
): void {
	if (deployment.network !== network) {
		failures.push(`${network}: deployment.network must be ${network}`);
	}

	for (const [name, address] of deploymentAddressEntries(deployment.contracts)) {
		if (!isAddress(address)) {
			failures.push(`${network}.${name} is not a valid EVM address: ${address}`);
		}
	}
}

function validateDeploymentTier(
	network: DeploymentNetwork,
	deployment: Deployments,
): void {
	const tier = NETWORK_TIER[network];

	if (!DEPLOYMENT_TIERS.includes(tier)) {
		failures.push(`${network}: no deployment tier is defined in NETWORK_TIER`);
		return;
	}

	if (deployment.tier !== tier) {
		failures.push(
			`${network}: config tier "${deployment.tier}" does not match NETWORK_TIER "${tier}"`,
		);
	}

	// NETWORK_TIER is the single source of truth and source manifests do not
	// normally carry a tier, but if one is ever added it must agree — catch drift
	// rather than let a stale source tier pass silently.
	const sourceTier = readJsonObject(
		join(repoRoot, "contracts", "deployments", `${network}.json`),
	).tier;
	if (sourceTier !== undefined && sourceTier !== tier) {
		failures.push(
			`${network}: source manifest tier "${String(sourceTier)}" does not match NETWORK_TIER "${tier}"`,
		);
	}

	const { chainId } = deployment;

	if (tier === "staging" && chainId !== 43_113 && chainId !== 68_420) {
		failures.push(
			`${network}: staging tier requires chainId 43113 or 68420, got ${chainId}`,
		);
	}

	if (tier === "production" && chainId !== 43_114) {
		failures.push(
			`${network}: production tier requires chainId 43114, got ${chainId}`,
		);
	}
}

function isPlaceholderManifest(network: DeploymentNetwork): boolean {
	const sourcePath = join(repoRoot, "contracts", "deployments", `${network}.json`);
	const source = readJsonObject(sourcePath);

	return source.placeholder === true;
}

function validateStablecoins(): void {
	for (const [network, coins] of Object.entries(STABLECOINS)) {
		for (const [symbol, info] of Object.entries(coins)) {
			if (info === undefined) {
				continue;
			}

			if (!isAddress(info.address)) {
				failures.push(
					`STABLECOINS.${network}.${symbol} is not a valid EVM address: ${info.address}`,
				);
			}

			if (info.decimals !== 6) {
				failures.push(
					`STABLECOINS.${network}.${symbol} must have decimals === 6, got ${info.decimals}`,
				);
			}
		}
	}

	// USDC must be registered for networks that wrap a real Circle token.
	for (const network of ["fuji", "avalanche"] as const) {
		if (STABLECOINS[network].USDC === undefined) {
			failures.push(`STABLECOINS.${network}.USDC is required`);
		}
	}

	// benzonet is exempt from the Circle-USDC requirement because it wraps a
	// deployed TestUSDC — assert that TestUSDC still lives in its manifest.
	if (deploymentsByNetwork.benzonet.contracts.tUSDC === undefined) {
		failures.push(
			"benzonet manifest must define a tUSDC/testUSDC address (STABLECOINS.benzonet is intentionally empty)",
		);
	}
}

function assertDeploymentMatchesSource(
	network: DeploymentNetwork,
	deployment: Deployments,
): void {
	const sourcePath = join(repoRoot, "contracts", "deployments", `${network}.json`);
	const source = readJsonObject(sourcePath);
	const expected = compactDeployment(network, source);

	if (JSON.stringify(deployment) !== JSON.stringify(expected)) {
		failures.push(
			`${relative(repoRoot, join("packages", "config", "src", "deployments", `${network}.json`))} does not match ${relative(repoRoot, sourcePath)}`,
		);
	}
}

function compactDeployment(
	network: DeploymentNetwork,
	source: JsonObject,
): Deployments {
	const chainId = readNumber(source, ["chainId"]);
	const contracts = readObject(source, ["contracts"]);
	const eerc = readObject(contracts, ["eercConverter"]);
	const verifiers = readObject(eerc, ["verifiers"]);
	const compactContracts: DeploymentContracts = {
		verifiers: Object.fromEntries(
			CIRCUIT_OPERATIONS.map((operation) => [
				operation,
				readDeploymentAddress(verifiers, [operation]),
			]),
		) as DeploymentContracts["verifiers"],
	};

	copyOptionalAddress(compactContracts, "Registrar", eerc, ["registrar"]);
	copyOptionalAddress(compactContracts, "EncryptedERC", eerc, ["encryptedERC"]);
	// Project the multi-token map when the source declares one. No manifest
	// carries `eercConverter.tokens` yet, so fuji/benzonet still resolve only the
	// deprecated tUSDC alias below and nothing is added here.
	const tokens = readOptionalTokens(eerc, ["tokens"]);
	if (tokens !== undefined) {
		compactContracts.tokens = tokens;
	}
	// Prefer the testUSDC deploy record; only fall back to wrappedToken if
	// testUSDC is absent, so we never silently overwrite one with the other.
	copyOptionalAddress(compactContracts, "tUSDC", eerc, ["testUSDC"]);
	if (compactContracts.tUSDC === undefined) {
		copyOptionalAddress(compactContracts, "tUSDC", eerc, ["wrappedToken"]);
	}
	copyOptionalAddress(compactContracts, "HandleRegistry", contracts, [
		"handleRegistry",
	]);
	copyOptionalAddress(compactContracts, "InvoiceRegistry", contracts, [
		"InvoiceRegistry",
	]);
	copyOptionalAddress(compactContracts, "GiftEscrow", contracts, ["GiftEscrow"]);

	return {
		network,
		chainId: chainId as Deployments["chainId"],
		tier: NETWORK_TIER[network],
		contracts: compactContracts,
	};
}

function deploymentAddressEntries(
	contracts: DeploymentContracts,
): [string, string][] {
	const entries: [string, string][] = CIRCUIT_OPERATIONS.map((operation) => [
		`verifiers.${operation}`,
		contracts.verifiers[operation],
	]);

	for (const key of [
		"Registrar",
		"EncryptedERC",
		"tUSDC",
		"HandleRegistry",
		"InvoiceRegistry",
		"GiftEscrow",
	] as const) {
		const address = contracts[key];
		if (address !== undefined) {
			entries.push([key, address]);
		}
	}

	return entries;
}

function verifyCircuitManifestIfPresent(): void {
	if (!existsSync(circuitManifestPath)) {
		const rel = relative(repoRoot, circuitManifestPath);
		// The manifest is a generated (gitignored) artifact, so it's absent in a
		// plain CI checkout — warn loudly instead of silently passing. The job
		// that generates circuit artifacts sets STRICT_CIRCUIT_MANIFEST=1 to make
		// a missing/empty manifest a hard failure.
		if (process.env.STRICT_CIRCUIT_MANIFEST === "1") {
			failures.push(
				`${rel} is missing but STRICT_CIRCUIT_MANIFEST=1 — generate circuit artifacts before checking`,
			);
		} else {
			console.warn(
				`⚠ ${rel} not present — skipping circuit hash check (set STRICT_CIRCUIT_MANIFEST=1 to require it).`,
			);
		}
		return;
	}

	const parsed = JSON.parse(readFileSync(circuitManifestPath, "utf8")) as unknown;
	if (!Array.isArray(parsed)) {
		failures.push(`${relative(repoRoot, circuitManifestPath)} must be a JSON array`);
		return;
	}
	if (parsed.length === 0) {
		failures.push(`${relative(repoRoot, circuitManifestPath)} must not be empty`);
		return;
	}

	const seenFiles = new Set<string>();

	for (const [index, entry] of parsed.entries()) {
		verifyCircuitManifestEntry(index, entry, seenFiles);
	}

	for (const circuit of CIRCUIT_OPERATIONS) {
		for (const extension of CIRCUIT_EXTENSIONS) {
			const expectedFile = circuitArtifactFile(circuit, extension);
			if (!seenFiles.has(expectedFile)) {
				failures.push(`manifest must include ${expectedFile}`);
			}
		}
	}
}

function verifyCircuitManifestEntry(
	index: number,
	value: unknown,
	seenFiles: Set<string>,
): void {
	if (!isJsonObject(value)) {
		failures.push(`manifest[${index}] must be an object`);
		return;
	}

	const entry = value as Partial<CircuitArtifactManifestEntry>;
	const file = entry.file;
	const sha256 = entry.sha256;
	const bytes = entry.bytes;
	const circuit = entry.circuit;

	if (
		typeof circuit !== "string" ||
		!CIRCUIT_OPERATIONS.includes(circuit as never)
	) {
		failures.push(`manifest[${index}].circuit must be a known circuit`);
	}

	if (
		typeof file !== "string" ||
		!CIRCUIT_EXTENSIONS.some((extension) => file.endsWith(`.${extension}`))
	) {
		failures.push(`manifest[${index}].file must be a circuit artifact filename`);
		return;
	}

	if (CIRCUIT_OPERATIONS.includes(circuit as never)) {
		const expectedFiles = CIRCUIT_EXTENSIONS.map((extension) =>
			circuitArtifactFile(circuit as CircuitArtifactManifestEntry["circuit"], extension),
		);

		if (!expectedFiles.includes(file as never)) {
			failures.push(
				`manifest[${index}].file must be one of: ${expectedFiles.join(", ")}`,
			);
		} else if (seenFiles.has(file)) {
			failures.push(`manifest contains duplicate artifact ${file}`);
		} else {
			seenFiles.add(file);
		}
	}

	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
		failures.push(`manifest[${index}].sha256 must be a lowercase sha256 digest`);
		return;
	}

	if (
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes) ||
		bytes <= 0
	) {
		failures.push(`manifest[${index}].bytes must be a positive safe integer`);
		return;
	}

	const artifactPath = join(circuitManifestDirectory, file);
	if (!existsSync(artifactPath)) {
		failures.push(`${file}: missing circuit artifact`);
		return;
	}

	const actualBytes = statSync(artifactPath).size;
	const actualSha256 = createHash("sha256")
		.update(readFileSync(artifactPath))
		.digest("hex");

	if (actualBytes !== bytes || actualSha256 !== sha256) {
		failures.push(`${file}: circuit artifact hash or byte length mismatch`);
	}
}

function copyOptionalAddress(
	target: DeploymentContracts,
	key: Exclude<keyof DeploymentContracts, "verifiers" | "tokens">,
	source: JsonObject,
	path: string[],
): void {
	const value = readOptionalDeploymentAddress(source, path);

	if (value !== undefined) {
		target[key] = value;
	}
}

function readOptionalTokens(
	source: JsonObject,
	path: string[],
): DeploymentContracts["tokens"] {
	const value = readPath(source, path);

	if (!isJsonObject(value)) {
		return undefined;
	}

	const tokens: NonNullable<DeploymentContracts["tokens"]> = {};

	for (const [key, entry] of Object.entries(value)) {
		if (!isJsonObject(entry)) {
			failures.push(`${path.join(".")}.${key} must be a token metadata object`);
			continue;
		}

		const { address, decimals, tokenId, symbol } = entry;

		if (
			typeof address !== "string" ||
			typeof decimals !== "number" ||
			typeof tokenId !== "number" ||
			typeof symbol !== "string"
		) {
			failures.push(`${path.join(".")}.${key} has an invalid token metadata shape`);
			continue;
		}

		// Manifest token maps must satisfy the same address + 6-decimal contract
		// as the STABLECOINS registry, so a malformed entry fails loudly instead of
		// being silently dropped or projected into the compact output.
		if (!isAddress(address)) {
			failures.push(
				`${path.join(".")}.${key}.address is not a valid EVM address: ${address}`,
			);
			continue;
		}

		if (decimals !== 6) {
			failures.push(`${path.join(".")}.${key}.decimals must be 6, got ${decimals}`);
			continue;
		}

		tokens[key] = { address: address as Address, decimals, tokenId, symbol };
	}

	return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function readDeploymentAddress(source: JsonObject, path: string[]): Address {
	const value = readOptionalDeploymentAddress(source, path);

	if (value === undefined) {
		throw new Error(`${path.join(".")} must contain an address`);
	}

	return value;
}

function readOptionalDeploymentAddress(
	source: JsonObject,
	path: string[],
): Address | undefined {
	const value = readPath(source, path);

	if (typeof value === "string") {
		return value as Address;
	}

	if (isJsonObject(value) && typeof value.address === "string") {
		return value.address as Address;
	}

	return undefined;
}

function readObject(source: JsonObject, path: string[]): JsonObject {
	const value = readPath(source, path);

	if (!isJsonObject(value)) {
		throw new Error(`${path.join(".")} must be an object`);
	}

	return value;
}

function readNumber(source: JsonObject, path: string[]): number {
	const value = readPath(source, path);

	if (typeof value !== "number") {
		throw new Error(`${path.join(".")} must be a number`);
	}

	return value;
}

function readPath(source: JsonObject, path: string[]): unknown {
	return path.reduce<unknown>((current, segment) => {
		if (!isJsonObject(current)) {
			return undefined;
		}

		return current[segment];
	}, source);
}

function readJsonObject(path: string): JsonObject {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

	if (!isJsonObject(parsed)) {
		throw new Error(`${path} must be a JSON object`);
	}

	return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
