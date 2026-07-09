/// <reference path="./snarkjs.d.ts" />
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	CEREMONY_CIRCUITS,
	type CeremonyCircuit,
	VERIFIER_SOL_BY_CIRCUIT,
} from "./ceremony/marker";

// #150 — SELF-CONSISTENT test verifiers for the eERC proof round-trip suite.
//
// The committed contracts/contracts/verifiers/*CircuitGroth16Verifier.sol are the
// REAL multi-party CEREMONY verifiers (marker build:"ceremony"). Their proving
// zkeys are non-reproducible (random contributions + a public beacon) and are
// gitignored, so CI never has them — it regenerates the DETERMINISTIC dev zkeys
// via `zkit make`. Proving against the dev zkeys and verifying against the
// ceremony verifiers is a guaranteed key mismatch → InvalidProof().
//
// The proof tests exist to exercise the proof *machinery* + the eERC flow, which
// only needs a self-consistent (proving key ↔ verifier) pair. This script
// exports, for each circuit, the Groth16 verifier that matches the SAME dev zkey
// `zkit.getCircuit(...).generateProof(...)` proves with, into a gitignored
// sources dir (contracts/contracts/verifiers-dev) under the `...Dev` name. The
// eERC tests (test/eerc/helpers.ts → deployVerifiers) deploy those, so the
// round-trip stays fully covered in CI without the ceremony zkeys.
//
// The committed CEREMONY verifiers are left untouched — their correctness is
// enforced separately by the ceremony-marker sha256 gate (scripts/ceremony/
// marker.ts, asserted in test/benzo/MainnetGuardrails.test.ts) and by the
// on-chain deploy that uses them verbatim.

const CONTRACTS_ROOT = path.join(__dirname, "..");
const ARTIFACTS_DIR = path.join(CONTRACTS_ROOT, "zkit", "artifacts", "circuits");
// Gitignored: regenerated from the current dev zkey on every `pretest`, so it can
// never drift from the proving key and never pollutes the committed tree.
const DEV_VERIFIERS_DIR = path.join(
	CONTRACTS_ROOT,
	"contracts",
	"verifiers-dev",
);

// zkit circuit base name, e.g. "registration" -> "RegistrationCircuit". Derived
// from the committed verifier filename so the two lists can never diverge.
const circuitBaseName = (circuit: CeremonyCircuit): string =>
	VERIFIER_SOL_BY_CIRCUIT[circuit].replace("Groth16Verifier.sol", "");

// The dev proving zkey `zkit.getCircuit(name).generateProof(...)` loads.
const devZkeyPath = (circuit: CeremonyCircuit): string => {
	const base = circuitBaseName(circuit);
	return path.join(ARTIFACTS_DIR, `${circuit}.circom`, `${base}.groth16.zkey`);
};

const devVerifierName = (circuit: CeremonyCircuit): string =>
	`${circuitBaseName(circuit)}Groth16VerifierDev`;

type SnarkjsZKey = {
	exportSolidityVerifier: (
		zkey: string,
		templates: { groth16: string },
	) => Promise<string>;
};

// snarkjs ships the groth16 verifier template; use it so the dev verifier keeps
// the exact SCALAR_FIELD/pairing layout the committed (also snarkjs-generated)
// verifiers use, and so it compiles under the same solc 0.8.27.
const loadGroth16Template = (): string => {
	const snarkjsEntry = require.resolve("snarkjs");
	const templatesDir = path.join(path.dirname(snarkjsEntry), "..", "templates");
	for (const candidate of [
		"verifier_groth16.sol.ejs",
		"verifier_groth16.sol",
	]) {
		const full = path.join(templatesDir, candidate);
		if (existsSync(full)) {
			return readFileSync(full, "utf8");
		}
	}
	throw new Error(
		"could not locate the snarkjs groth16 verifier template under its templates/ dir",
	);
};

// Rename the exported contract to the unique `...Dev` name so it never collides
// with the committed ceremony verifier of the same circuit (they coexist in the
// compile) and `ethers.getContractFactory("...Dev")` resolves unambiguously.
const renameVerifierContract = (solidity: string, name: string): string =>
	solidity.replace(/contract\s+\w*Verifier\b/, `contract ${name}`);

const generate = async (): Promise<void> => {
	const missing = CEREMONY_CIRCUITS.filter(
		(circuit) => !existsSync(devZkeyPath(circuit)),
	);
	if (missing.length > 0) {
		// The proof tests can't run without the dev zkeys either way; skip quietly
		// so non-proof suites still run (the eERC tests then fail fast on the
		// missing verifier artifact with a clear hint).
		console.warn(
			`[gen-test-verifiers] dev zkeys missing (${missing.join(", ")}); run "pnpm zkit:make" first. Skipping dev-verifier generation.`,
		);
		return;
	}

	let zKey: SnarkjsZKey;
	try {
		zKey = ((await import("snarkjs")) as { zKey: SnarkjsZKey }).zKey;
	} catch {
		throw new Error("snarkjs is not installed in the contracts workspace");
	}

	// Regenerate from scratch so a removed/renamed circuit never leaves a stale
	// dev verifier behind.
	rmSync(DEV_VERIFIERS_DIR, { recursive: true, force: true });
	mkdirSync(DEV_VERIFIERS_DIR, { recursive: true });

	const template = loadGroth16Template();

	for (const circuit of CEREMONY_CIRCUITS) {
		const name = devVerifierName(circuit);
		const solidity = renameVerifierContract(
			await zKey.exportSolidityVerifier(devZkeyPath(circuit), {
				groth16: template,
			}),
			name,
		);
		const outPath = path.join(DEV_VERIFIERS_DIR, `${name}.sol`);
		writeFileSync(outPath, solidity);
		console.log(
			`[gen-test-verifiers] wrote ${path.relative(CONTRACTS_ROOT, outPath)}`,
		);
	}
};

// snarkjs leaves its BN254 curve worker threads open after use, so the process
// never exits on its own — force a clean exit once the files are written (this
// runs on `pretest`, so a hang here would wedge every test run, incl. CI).
generate()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
