import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ApiConfig } from "../config.js";
import type {
	Groth16Calldata,
	RegistrationProofCalldata,
	TransferProofCalldata,
} from "./eerc.js";

export type PayrollProver = {
	proveRegistration: (input: Record<string, unknown>) => Promise<RegistrationProofCalldata>;
	proveTransfer: (input: Record<string, unknown>) => Promise<TransferProofCalldata>;
};

type CircuitName = "registration" | "transfer";

type WorkerResponse =
	| {
			ok: true;
			proof: SerializableGroth16Calldata;
	  }
	| {
			error: string;
			ok: false;
	  };

type SerializableGroth16Calldata = {
	proofPoints: {
		a: [string, string];
		b: [[string, string], [string, string]];
		c: [string, string];
	};
	publicSignals: string[];
};

export function createSnarkjsPayrollProver(config: ApiConfig): PayrollProver {
	return {
		async proveRegistration(input) {
			return proveInWorker(config, "registration", input) as Promise<RegistrationProofCalldata>;
		},
		async proveTransfer(input) {
			return proveInWorker(config, "transfer", input) as Promise<TransferProofCalldata>;
		},
	};
}

export function requiredArtifactPaths(
	config: ApiConfig,
	circuit: CircuitName,
): { wasmPath: string; zkeyPath: string } {
	return {
		wasmPath: path.join(config.payrollZkArtifactDir, `${circuit}.wasm`),
		zkeyPath: path.join(config.payrollZkArtifactDir, `${circuit}.zkey`),
	};
}

async function proveInWorker(
	config: ApiConfig,
	circuit: CircuitName,
	input: Record<string, unknown>,
): Promise<Groth16Calldata> {
	const artifacts = requiredArtifactPaths(config, circuit);
	await assertArtifactsExist(config, circuit, artifacts);

	const response = await runProofWorker({
		...artifacts,
		input: serializeBigints(input),
	});
	if (!response.ok) {
		throw new Error(response.error);
	}

	return deserializeProof(response.proof);
}

async function assertArtifactsExist(
	config: ApiConfig,
	circuit: CircuitName,
	artifacts: { wasmPath: string; zkeyPath: string },
): Promise<void> {
	try {
		await Promise.all([access(artifacts.wasmPath), access(artifacts.zkeyPath)]);
	} catch {
		throw new Error(
			`missing_${circuit}_zk_artifacts:${config.payrollZkArtifactDir}:` +
				`expected ${path.basename(artifacts.wasmPath)} and ${path.basename(artifacts.zkeyPath)}`,
		);
	}
}

function runProofWorker(workerData: {
	input: unknown;
	wasmPath: string;
	zkeyPath: string;
}): Promise<WorkerResponse> {
	const url = workerUrl();
	const worker = new Worker(url, {
		execArgv: fileURLToPath(url).endsWith(".ts") ? process.execArgv : [],
		workerData,
	});

	return new Promise((resolve, reject) => {
		worker.once("message", (message: WorkerResponse) => {
			resolve(message);
			void worker.terminate();
		});
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`proof_worker_exited:${code}`));
			}
		});
	});
}

function workerUrl(): URL {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = currentPath.endsWith(".ts") ? ".ts" : ".js";
	return pathToFileURL(path.join(path.dirname(currentPath), `proof-worker${extension}`));
}

function serializeBigints(value: unknown): unknown {
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map((entry) => serializeBigints(entry));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, serializeBigints(entry)]),
		);
	}

	return value;
}

function deserializeProof(proof: SerializableGroth16Calldata): Groth16Calldata {
	return {
		proofPoints: {
			a: proof.proofPoints.a.map(BigInt) as [bigint, bigint],
			b: proof.proofPoints.b.map((row) => row.map(BigInt)) as [
				[bigint, bigint],
				[bigint, bigint],
			],
			c: proof.proofPoints.c.map(BigInt) as [bigint, bigint],
		},
		publicSignals: proof.publicSignals.map(BigInt),
	};
}
