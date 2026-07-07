import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const CIRCUITS = [
	{ circuit: "registration", zkitCircuit: "RegistrationCircuit" },
	{ circuit: "transfer", zkitCircuit: "TransferCircuit" },
	{ circuit: "mint", zkitCircuit: "MintCircuit" },
	{ circuit: "withdraw", zkitCircuit: "WithdrawCircuit" },
	{ circuit: "burn", zkitCircuit: "BurnCircuit" },
] as const;

const EXTENSIONS = ["wasm", "zkey"] as const;

type Circuit = (typeof CIRCUITS)[number];
type Extension = (typeof EXTENSIONS)[number];

type ManifestEntry = {
	circuit: Circuit["circuit"];
	file: `${Circuit["circuit"]}/${Circuit["circuit"]}.${Extension}`;
	sha256: string;
	bytes: number;
};

const contractsRoot = resolve(__dirname, "..");
const repoRoot = resolve(contractsRoot, "..");
const artifactsRoot = resolve(
	process.env.BENZO_ZKIT_ARTIFACTS_DIR ?? join(contractsRoot, "zkit", "artifacts"),
);
const outputRoot = resolve(
	process.env.BENZO_CIRCUIT_PUBLIC_DIR ??
		join(repoRoot, "packages", "config", "public", "circuits"),
);
const manifestPath = join(outputRoot, "manifest.json");

function main() {
	assertDirectory(
		artifactsRoot,
		`Missing ${relative(repoRoot, artifactsRoot)}. Run "pnpm zkit:make" from contracts/ first.`,
	);

	// Only clear the per-circuit bundles we own — never the output root itself,
	// which may be an operator-supplied publish/parent dir via
	// BENZO_CIRCUIT_PUBLIC_DIR. A blanket rm of that root could wipe unrelated data.
	mkdirSync(outputRoot, { recursive: true });
	for (const circuit of CIRCUITS) {
		rmSync(join(outputRoot, circuit.circuit), { recursive: true, force: true });
	}

	const manifest: ManifestEntry[] = [];

	for (const circuit of CIRCUITS) {
		for (const extension of EXTENSIONS) {
			const source = findGeneratedArtifact(circuit, extension);
			const file =
				`${circuit.circuit}/${circuit.circuit}.${extension}` as ManifestEntry["file"];
			const destination = join(outputRoot, file);

			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(source, destination);

			const bytes = statSync(destination).size;
			const sha256 = sha256File(destination);

			manifest.push({
				circuit: circuit.circuit,
				file,
				sha256,
				bytes,
			});

			console.log(
				`staged ${relative(repoRoot, source)} -> ${relative(repoRoot, destination)} (${bytes} bytes, sha256 ${sha256})`,
			);
		}
	}

	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`wrote ${relative(repoRoot, manifestPath)} (${manifest.length} entries)`);
}

function assertDirectory(path: string, message: string): void {
	if (!existsSync(path) || !statSync(path).isDirectory()) {
		throw new Error(message);
	}
}

function findGeneratedArtifact(circuit: Circuit, extension: Extension): string {
	const matches = listFiles(artifactsRoot)
		.filter((file) => artifactMatchesCircuit(file, circuit, extension))
		.sort((left, right) => compareCandidates(left, right, circuit, extension));

	if (matches.length === 0) {
		throw new Error(
			`Missing final ${circuit.circuit}.${extension} under ${relative(repoRoot, artifactsRoot)}.`,
		);
	}

	if (matches.length > 1) {
		// If the best candidates are indistinguishable by score, picking one by
		// path order would silently stage a "best guess" .wasm/.zkey — fail hard
		// instead, since the wrong proving artifact breaks the in-browser prover.
		const topScore = scoreCandidate(matches[0], circuit, extension);
		const tiedTop = matches.filter(
			(match) => scoreCandidate(match, circuit, extension) === topScore,
		);
		if (tiedTop.length > 1) {
			throw new Error(
				[
					`Ambiguous artifacts matched ${circuit.circuit}.${extension}:`,
					...tiedTop.map((match) => `  - ${relative(repoRoot, match)}`),
				].join("\n"),
			);
		}
		console.warn(
			`Multiple candidates matched ${circuit.circuit}.${extension}; using best-scored ${relative(
				repoRoot,
				matches[0],
			)}.`,
		);
	}

	return matches[0];
}

function artifactMatchesCircuit(
	file: string,
	circuit: Circuit,
	extension: Extension,
): boolean {
	const base = basename(file).toLowerCase();
	const relativePath = relative(artifactsRoot, file).toLowerCase();
	const circuitName = circuit.circuit.toLowerCase();
	const zkitCircuitName = circuit.zkitCircuit.toLowerCase();

	if (!base.endsWith(`.${extension}`)) {
		return false;
	}

	const expectedBasenames = new Set([
		`${circuitName}.${extension}`,
		`${zkitCircuitName}.${extension}`,
		`${circuitName}.groth16.${extension}`,
		`${zkitCircuitName}.groth16.${extension}`,
	]);

	if (expectedBasenames.has(base)) {
		return true;
	}

	return (
		extension === "zkey" &&
		(base === "final.zkey" || base.endsWith(".final.zkey")) &&
		(relativePath.includes(circuitName) || relativePath.includes(zkitCircuitName))
	);
}

function compareCandidates(
	left: string,
	right: string,
	circuit: Circuit,
	extension: Extension,
): number {
	return (
		scoreCandidate(left, circuit, extension) -
			scoreCandidate(right, circuit, extension) ||
		left.length - right.length ||
		comparePaths(left, right)
	);
}

function scoreCandidate(
	file: string,
	circuit: Circuit,
	extension: Extension,
): number {
	const base = basename(file).toLowerCase();
	const circuitName = circuit.circuit.toLowerCase();
	const zkitCircuitName = circuit.zkitCircuit.toLowerCase();

	if (base === `${circuitName}.${extension}`) {
		return 0;
	}

	if (base === `${zkitCircuitName}.${extension}`) {
		return 1;
	}

	if (base === `${circuitName}.groth16.${extension}`) {
		return 2;
	}

	if (base === `${zkitCircuitName}.groth16.${extension}`) {
		return 3;
	}

	return 4;
}

function comparePaths(left: string, right: string): number {
	if (left < right) {
		return -1;
	}

	if (left > right) {
		return 1;
	}

	return 0;
}

function listFiles(directory: string): string[] {
	const files: string[] = [];

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) {
			files.push(...listFiles(path));
			continue;
		}

		if (entry.isFile()) {
			files.push(path);
		}
	}

	return files;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

main();
