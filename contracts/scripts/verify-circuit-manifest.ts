import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Focused, override-aware check of a staged circuit-artifact bundle: it validates
// ONLY the manifest + hashes at the same directory `artifacts:stage` writes to
// (BENZO_CIRCUIT_PUBLIC_DIR), so it neither ignores a staged override nor couples
// artifact verification to unrelated @benzo/config deployment checks.

const CIRCUITS = ["registration", "transfer", "mint", "withdraw", "burn"] as const;
const EXTENSIONS = ["wasm", "zkey"] as const;

const contractsRoot = resolve(__dirname, "..");
const repoRoot = resolve(contractsRoot, "..");
const outputRoot = resolve(
	process.env.BENZO_CIRCUIT_PUBLIC_DIR ??
		join(repoRoot, "packages", "config", "public", "circuits"),
);
const manifestPath = join(outputRoot, "manifest.json");
const rel = relative(repoRoot, manifestPath);

const failures: string[] = [];

if (!existsSync(manifestPath)) {
	// The manifest is a generated (gitignored) artifact, absent in a plain
	// checkout. The publish job sets STRICT_CIRCUIT_MANIFEST=1 to require it.
	if (process.env.STRICT_CIRCUIT_MANIFEST === "1") {
		console.error(
			`${rel} is missing but STRICT_CIRCUIT_MANIFEST=1 — run "pnpm artifacts:stage" first.`,
		);
		process.exit(1);
	}
	console.warn(
		`⚠ ${rel} not present — skipping circuit hash check (set STRICT_CIRCUIT_MANIFEST=1 to require it).`,
	);
	process.exit(0);
}

const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
if (!Array.isArray(parsed)) {
	failures.push(`${rel} must be a JSON array`);
} else if (parsed.length === 0) {
	failures.push(`${rel} must not be empty`);
} else {
	const seenFiles = new Set<string>();
	for (const [index, entry] of parsed.entries()) {
		verifyEntry(index, entry, seenFiles);
	}
	for (const circuit of CIRCUITS) {
		for (const extension of EXTENSIONS) {
			const expected = `${circuit}/${circuit}.${extension}`;
			if (!seenFiles.has(expected)) {
				failures.push(`manifest must include ${expected}`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error(`Circuit manifest check failed for ${rel}:`);
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log(`Verified circuit artifact hashes from ${rel}.`);

function verifyEntry(
	index: number,
	value: unknown,
	seenFiles: Set<string>,
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		failures.push(`manifest[${index}] must be an object`);
		return;
	}

	const entry = value as {
		circuit?: unknown;
		file?: unknown;
		sha256?: unknown;
		bytes?: unknown;
	};
	const { circuit, file, sha256, bytes } = entry;

	if (typeof circuit !== "string" || !CIRCUITS.includes(circuit as never)) {
		failures.push(`manifest[${index}].circuit must be a known circuit`);
	}

	const expectedFiles =
		typeof circuit === "string" && CIRCUITS.includes(circuit as never)
			? EXTENSIONS.map((extension) => `${circuit}/${circuit}.${extension}`)
			: [];

	if (typeof file !== "string" || !expectedFiles.includes(file)) {
		failures.push(
			`manifest[${index}].file must be one of: ${expectedFiles.join(", ") || "<known circuit artifact>"}`,
		);
		return;
	}
	if (seenFiles.has(file)) {
		failures.push(`manifest contains duplicate artifact ${file}`);
		return;
	}
	seenFiles.add(file);

	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
		failures.push(`manifest[${index}].sha256 must be a lowercase sha256 digest`);
		return;
	}
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
		failures.push(`manifest[${index}].bytes must be a positive safe integer`);
		return;
	}

	const artifactPath = join(outputRoot, file);
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
