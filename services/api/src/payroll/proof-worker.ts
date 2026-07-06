import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	parentPort,
	Worker as NodeWorker,
	workerData,
} from "node:worker_threads";

type SnarkJsModule = {
	groth16: {
		fullProve: (
			input: unknown,
			wasmPath: string,
			zkeyPath: string,
		) => Promise<{
			proof: {
				pi_a: [string, string, string];
				pi_b: [[string, string], [string, string], [string, string]];
				pi_c: [string, string, string];
			};
			publicSignals: string[];
		}>;
	};
};

type ProofWorkerData = {
	input: unknown;
	wasmPath: string;
	zkeyPath: string;
};

try {
	installWebWorkerShim();
	const snarkjs = (await import("snarkjs")) as SnarkJsModule;
	const data = workerData as ProofWorkerData;
	const result = await snarkjs.groth16.fullProve(
		data.input,
		data.wasmPath,
		data.zkeyPath,
	);

	parentPort?.postMessage({
		ok: true,
		proof: {
			proofPoints: {
				a: [result.proof.pi_a[0], result.proof.pi_a[1]],
				b: [
					[result.proof.pi_b[0][1], result.proof.pi_b[0][0]],
					[result.proof.pi_b[1][1], result.proof.pi_b[1][0]],
				],
				c: [result.proof.pi_c[0], result.proof.pi_c[1]],
			},
			publicSignals: result.publicSignals,
		},
	});
} catch (error) {
	parentPort?.postMessage({
		error: error instanceof Error ? error.message : "proof_worker_failed",
		ok: false,
	});
}

function installWebWorkerShim(): void {
	const requireForWorker = createRequire(import.meta.url);
	const webWorkerPath = requireForWorker.resolve("web-worker");

	// ffjavascript imports `web-worker`; inside our outer proof worker that
	// package misdetects itself as the worker side. Force the constructor side.
	class EventTargetShim {
		readonly listeners = new Map<string, Array<(event: unknown) => void>>();

		addEventListener(type: string, handler: (event: unknown) => void): void {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push(handler);
			this.listeners.set(type, listeners);
		}

		removeEventListener(type: string, handler: (event: unknown) => void): void {
			const listeners = this.listeners.get(type);
			if (!listeners) {
				return;
			}
			const index = listeners.indexOf(handler);
			if (index >= 0) {
				listeners.splice(index, 1);
			}
		}

		dispatchEvent(event: { type: string }): void {
			for (const handler of this.listeners.get(event.type) ?? []) {
				handler(event);
			}
		}
	}

	class WebWorkerShim extends EventTargetShim {
		onclose: ((event: unknown) => void) | null = null;
		onerror: ((event: unknown) => void) | null = null;
		onmessage: ((event: unknown) => void) | null = null;
		readonly worker: NodeWorker;

		constructor(url: string | URL, options?: { name?: string; type?: string }) {
			super();
			const workerUrl = String(url);
			const mod = workerUrl.startsWith("data:")
				? workerUrl
				: fileURLToPath(new URL(workerUrl, pathToFileURL(`${process.cwd()}/`)));

			this.worker = new NodeWorker(webWorkerPath, {
				execArgv: [],
				workerData: {
					mod,
					name: options?.name,
					type: options?.type,
				},
			});
			this.worker.on("message", (data) => {
				const event = { data, type: "message" };
				this.onmessage?.(event);
				this.dispatchEvent(event);
			});
			this.worker.on("error", (error) => {
				const event = { error, type: "error" };
				this.onerror?.(event);
				this.dispatchEvent(event);
			});
			this.worker.on("exit", () => {
				const event = { type: "close" };
				this.onclose?.(event);
				this.dispatchEvent(event);
			});
		}

		postMessage(data: unknown, transferList?: readonly unknown[]): void {
			this.worker.postMessage(data, transferList as never[] | undefined);
		}

		terminate(): Promise<number> {
			return this.worker.terminate();
		}
	}

	requireForWorker.cache[webWorkerPath] = {
		children: [],
		exports: WebWorkerShim,
		filename: webWorkerPath,
		id: webWorkerPath,
		isPreloading: false,
		loaded: true,
		parent: null,
		path: "",
		paths: [],
		require: requireForWorker,
	} as NodeModule;
}
