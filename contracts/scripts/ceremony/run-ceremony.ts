import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	CEREMONY_CIRCUITS,
	CEREMONY_MARKER_PATH,
	type CeremonyCircuit,
	type CeremonyMarker,
	VERIFIER_SOL_BY_CIRCUIT,
	VERIFIERS_DIR,
	sha256File,
} from "./marker";

// #121 — PRODUCTION Groth16 phase-2 trusted-setup ceremony driver.
//
// ── HONEST SCOPE ──────────────────────────────────────────────────────────
// The verifiers currently committed (and on Fuji) come from a DEV setup
// (hardhat.config.ts → contributionSettings.contributions: 0). This script is
// the tooling an operator runs to REPLACE them with a real ceremony build:
//   1. start from an appropriate Powers-of-Tau (phase-1),
//   2. per circuit: newZKey → >=1 independent phase-2 contribution → public
//      random beacon → final .zkey,
//   3. regenerate the *CircuitGroth16Verifier.sol under contracts/verifiers,
//   4. rewrite scripts/ceremony/ceremony-marker.json to build:"ceremony" so deploy:mainnet
//      accepts the setup.
//
// A GENUINE ceremony needs SEVERAL INDEPENDENT operators each contributing from
// a machine you do not control, with the transcript published. A single process
// applying N local contributions is NOT that — it is the mechanics, not the
// trust. Treat multi-operator coordination + transcript publication as the real
// (paused) work; this script automates the per-machine steps and the marker.
//
// It NEVER runs on import and refuses without CEREMONY_CONFIRM=1, so it cannot
// desync Fuji by accident. It is deliberately NOT part of `pnpm test`.
//
// Required env when run:
//   CEREMONY_CONFIRM=1            explicit opt-in
//   CEREMONY_PTAU=<path>          phase-1 Powers-of-Tau (.ptau) large enough for the circuits
//   CEREMONY_BEACON=<hex>         public random beacon (e.g. a future block hash), 32 bytes hex
// Optional:
//   CEREMONY_CONTRIBUTIONS=<n>    local phase-2 contributions to apply (default 1)
//   CEREMONY_BEACON_ITERS=<n>     beacon iterations exponent (default 10)
//   CEREMONY_TRANSCRIPT_URL=<url> where the published transcript will live
//   CEREMONY_OUT=<dir>            ceremony working dir (default contracts/zkit/ceremony)
//   BENZO_ZKIT_ARTIFACTS_DIR=<d>  zkit artifacts dir holding the compiled .r1cs

type SnarkjsZKey = {
	newZKey: (r1cs: string, ptau: string, zkeyOut: string) => Promise<unknown>;
	contribute: (
		zkeyIn: string,
		zkeyOut: string,
		name: string,
		entropy: string,
	) => Promise<unknown>;
	beacon: (
		zkeyIn: string,
		zkeyOut: string,
		name: string,
		beaconHash: string,
		numIterationsExp: number,
	) => Promise<unknown>;
	exportSolidityVerifier: (
		zkey: string,
		templates: { groth16: string },
	) => Promise<string>;
};

const CONTRACTS_ROOT = path.join(__dirname, "..", "..");

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value || value.length === 0) {
		throw new Error(`${name} is required to run the production ceremony`);
	}
	return value;
};

const findR1cs = (artifactsDir: string, circuit: CeremonyCircuit): string => {
	const target = `${circuit}.r1cs`.toLowerCase();
	const zkitTarget = `${circuit}circuit.r1cs`.toLowerCase();
	const stack = [artifactsDir];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			const base = entry.name.toLowerCase();
			if (base === target || base === zkitTarget) {
				return full;
			}
		}
	}
	throw new Error(
		`could not find ${circuit}.r1cs under ${artifactsDir} — run "pnpm zkit:make" first`,
	);
};

// snarkjs ships the groth16 verifier template; locate it so the regenerated
// verifier keeps the exact SCALAR_FIELD/pairing layout the deploy expects.
const loadGroth16Template = (): string => {
	const override = process.env.CEREMONY_VERIFIER_TEMPLATE;
	if (override && existsSync(override)) {
		return readFileSync(override, "utf8");
	}
	const snarkjsEntry = require.resolve("snarkjs");
	const templatesDir = path.join(
		path.dirname(snarkjsEntry),
		"..",
		"templates",
	);
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
		"could not locate the snarkjs groth16 verifier template; set CEREMONY_VERIFIER_TEMPLATE to its path",
	);
};

// Rename the exported contract to the *CircuitGroth16Verifier name the deploy
// scripts resolve by, without touching the verification-key math.
const renameVerifierContract = (
	solidity: string,
	circuit: CeremonyCircuit,
): string => {
	const contractName = VERIFIER_SOL_BY_CIRCUIT[circuit].replace(/\.sol$/, "");
	return solidity.replace(
		/contract\s+\w*Verifier\b/,
		`contract ${contractName}`,
	);
};

const runCeremony = async (): Promise<void> => {
	if (process.env.CEREMONY_CONFIRM !== "1") {
		throw new Error(
			"refusing to run: set CEREMONY_CONFIRM=1 to run the production ceremony (this replaces the committed verifiers)",
		);
	}

	const ptau = requireEnv("CEREMONY_PTAU");
	const beacon = requireEnv("CEREMONY_BEACON");
	if (!/^0x[0-9a-fA-F]{64,}$/.test(beacon)) {
		throw new Error("CEREMONY_BEACON must be a >=32-byte hex public random beacon");
	}
	const contributions = Number(process.env.CEREMONY_CONTRIBUTIONS ?? "1");
	if (!Number.isInteger(contributions) || contributions < 1) {
		throw new Error("CEREMONY_CONTRIBUTIONS must be a positive integer");
	}
	const beaconIters = Number(process.env.CEREMONY_BEACON_ITERS ?? "10");
	if (!Number.isInteger(beaconIters) || beaconIters < 1) {
		throw new Error("CEREMONY_BEACON_ITERS must be a positive integer");
	}
	// The marker (and thus deploy:mainnet) requires a published transcript, so a
	// ceremony run without one is refused up front.
	const transcriptUrl = requireEnv("CEREMONY_TRANSCRIPT_URL");
	if (!/^https:\/\/\S+$/.test(transcriptUrl)) {
		throw new Error("CEREMONY_TRANSCRIPT_URL must be a published https transcript URL");
	}
	const artifactsDir = path.resolve(
		process.env.BENZO_ZKIT_ARTIFACTS_DIR ??
			path.join(CONTRACTS_ROOT, "zkit", "artifacts"),
	);
	const outDir = path.resolve(
		process.env.CEREMONY_OUT ?? path.join(CONTRACTS_ROOT, "zkit", "ceremony"),
	);
	mkdirSync(outDir, { recursive: true });

	if (!existsSync(ptau)) {
		throw new Error(`CEREMONY_PTAU ${ptau} does not exist`);
	}

	// Dynamic import: snarkjs is only needed to RUN the ceremony, so it stays out
	// of the contracts workspace's dependencies and off the compile/test path.
	let zKey: SnarkjsZKey;
	try {
		zKey = ((await import("snarkjs")) as { zKey: SnarkjsZKey }).zKey;
	} catch {
		throw new Error(
			"snarkjs is not installed. Install it in the contracts workspace to run the ceremony.",
		);
	}

	const template = loadGroth16Template();

	for (const circuit of CEREMONY_CIRCUITS) {
		const r1cs = findR1cs(artifactsDir, circuit);
		const finalZkey = path.join(outDir, `${circuit}.final.zkey`);

		// ── Path A: adopt a pre-computed MULTI-PARTY final zkey ────────────────
		// When CEREMONY_FINAL_ZKEY_DIR is set, the final .zkey for each circuit was
		// already produced OUT OF BAND by a real multi-operator phase-2 contribution
		// chain (cer-1 -> cer-2 -> cer-3, per-machine entropy) + a public drand
		// beacon; the chain-of-custody hashes are published in the transcript at
		// CEREMONY_TRANSCRIPT_URL. We adopt that .zkey verbatim and SKIP the
		// in-process newZKey / contribute / beacon so the exported verifier is
		// coupled to the ACTUAL ceremony key, then fall through to the UNCHANGED
		// verifier export below. CEREMONY_CONTRIBUTIONS / CEREMONY_BEACON still
		// populate the marker to describe that out-of-band ceremony.
		const finalZkeyDir = process.env.CEREMONY_FINAL_ZKEY_DIR;
		if (finalZkeyDir) {
			const src = path.join(finalZkeyDir, `${circuit}.final.zkey`);
			if (!existsSync(src)) {
				throw new Error(
					`CEREMONY_FINAL_ZKEY_DIR is set but ${src} is missing`,
				);
			}
			if (path.resolve(src) !== path.resolve(finalZkey)) {
				copyFileSync(src, finalZkey);
			}
			console.log(
				`[${circuit}] adopted multi-party final zkey from ${path.relative(CONTRACTS_ROOT, src)}`,
			);
		} else {
			const zkey0 = path.join(outDir, `${circuit}.0000.zkey`);
			console.log(`[${circuit}] newZKey from ${path.basename(ptau)}`);
			await zKey.newZKey(r1cs, ptau, zkey0);

			let current = zkey0;
			for (let i = 1; i <= contributions; i += 1) {
				const next = path.join(
					outDir,
					`${circuit}.${String(i).padStart(4, "0")}.zkey`,
				);
				console.log(`[${circuit}] contribution ${i}/${contributions}`);
				// A real ceremony collects entropy from an independent operator; the
				// local randomBytes here stands in for the per-machine step.
				await zKey.contribute(
					current,
					next,
					`benzo-ceremony-${circuit}-${i}`,
					randomBytes(32).toString("hex"),
				);
				current = next;
			}

			console.log(`[${circuit}] applying public beacon`);
			await zKey.beacon(
				current,
				finalZkey,
				`benzo-ceremony-${circuit}-beacon`,
				beacon,
				beaconIters,
			);
		}

		console.log(`[${circuit}] exporting verifier solidity`);
		const solidity = renameVerifierContract(
			await zKey.exportSolidityVerifier(finalZkey, { groth16: template }),
			circuit,
		);
		const verifierPath = path.join(
			VERIFIERS_DIR,
			VERIFIER_SOL_BY_CIRCUIT[circuit],
		);
		writeFileSync(verifierPath, solidity);
		console.log(`[${circuit}] wrote ${path.relative(CONTRACTS_ROOT, verifierPath)}`);
	}

	// Flipping the marker to build:"ceremony" is what opens the deploy:mainnet
	// gate — refuse to do it until the operator confirms the browser .wasm/.zkey
	// and packages/config/public/circuits/manifest.json were regenerated from
	// these final zkeys, so the gate can never open on stale proving artifacts.
	if (process.env.CEREMONY_ARTIFACTS_CONFIRMED !== "1") {
		throw new Error(
			"Verifiers regenerated, but the mainnet gate stays CLOSED: regenerate the browser " +
				".wasm/.zkey + packages/config/public/circuits/manifest.json from these final zkeys " +
				"(pnpm artifacts:stage), then re-run with CEREMONY_ARTIFACTS_CONFIRMED=1 to write the " +
				"ceremony marker.",
		);
	}

	// Rewrite the marker so deploy:mainnet accepts the setup. The verifier hashes
	// are recomputed from what we just wrote.
	const marker: CeremonyMarker = {
		build: "ceremony",
		provingSystem: "groth16",
		contributions,
		beacon,
		ptau: path.basename(ptau),
		transcriptUrl,
		note: "Production Groth16 phase-2 ceremony. Publish the transcript/attestations at transcriptUrl and regenerate the browser .wasm/.zkey + packages/config/public/circuits/manifest.json from these final zkeys.",
		verifiers: Object.fromEntries(
			CEREMONY_CIRCUITS.map((circuit) => [
				circuit,
				{
					source: `contracts/contracts/verifiers/${VERIFIER_SOL_BY_CIRCUIT[circuit]}`,
					sha256: sha256File(
						path.join(VERIFIERS_DIR, VERIFIER_SOL_BY_CIRCUIT[circuit]),
					),
				},
			]),
		) as CeremonyMarker["verifiers"],
	};
	writeFileSync(CEREMONY_MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`);
	console.log(`wrote ${path.relative(CONTRACTS_ROOT, CEREMONY_MARKER_PATH)}`);

	console.log(
		[
			"",
			"Ceremony complete. Remaining operator steps (NOT automated here):",
			"  - regenerate the browser .wasm/.zkey from the final zkeys and refresh",
			"    packages/config/public/circuits/manifest.json (pnpm artifacts:stage),",
			"  - publish the transcript/attestations at CEREMONY_TRANSCRIPT_URL,",
			"  - commit the regenerated verifiers + ceremony-marker.json,",
			"  - re-run the deploy:mainnet guardrails in a C-Chain fork dry-run.",
		].join("\n"),
	);
};

// Never auto-run on import (tests import ./marker, not this driver).
if (require.main === module) {
	runCeremony().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

export { runCeremony };
