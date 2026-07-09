import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Circle Iris (CCTP V2) attestation client.
//
// Two hard requirements from the M4 test strategy:
//   1. Polling is BOUNDED — a wall-clock deadline plus a fixed poll interval,
//      never an open-ended `sleep(finality)`. If the attestation is not ready by
//      the deadline the call throws, so a slow relayer can't hang a nightly run.
//   2. A VCR replay mode — when BENZO_CCTP_REPLAY points at a directory, attested
//      responses are read from disk (recorded on a prior live run when
//      BENZO_CCTP_RECORD=1), so a suite can be exercised deterministically and
//      offline without waiting on Circle.

export type Attestation = {
	message: `0x${string}`;
	attestation: `0x${string}`;
	eventNonce: string;
	status: string;
};

export type FetchAttestationOptions = {
	attestationApiBase: string;
	sourceDomain: number;
	transactionHash: `0x${string}`;
	/** Hard upper bound on total polling time (ms). Default 20 minutes. */
	timeoutMs?: number;
	/** Delay between polls (ms). Default 8 seconds. */
	pollIntervalMs?: number;
	/** Injected clock/sleep, for tests. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 8_000;

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function replayDir(): string | undefined {
	const dir = process.env.BENZO_CCTP_REPLAY;
	return dir === undefined || dir === "" ? undefined : dir;
}

function isRecording(): boolean {
	return process.env.BENZO_CCTP_RECORD === "1";
}

function cassetteName(sourceDomain: number, txHash: string): string {
	return `${sourceDomain}-${txHash.toLowerCase()}.json`;
}

async function readCassette(
	dir: string,
	sourceDomain: number,
	txHash: string,
): Promise<Attestation | undefined> {
	try {
		const raw = await readFile(
			join(dir, cassetteName(sourceDomain, txHash)),
			"utf8",
		);
		return JSON.parse(raw) as Attestation;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function writeCassette(
	dir: string,
	sourceDomain: number,
	txHash: string,
	attestation: Attestation,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, cassetteName(sourceDomain, txHash)),
		`${JSON.stringify(attestation, null, 2)}\n`,
	);
}

function parseIrisResponse(payload: unknown): Attestation | undefined {
	const messages = (payload as { messages?: unknown[] })?.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return undefined;
	}
	const first = messages[0] as {
		status?: string;
		message?: string;
		attestation?: string;
		eventNonce?: string;
	};
	if (first.status !== "complete") {
		return undefined;
	}
	if (
		typeof first.message !== "string" ||
		typeof first.attestation !== "string"
	) {
		return undefined;
	}
	return {
		message: first.message as `0x${string}`,
		attestation: first.attestation as `0x${string}`,
		eventNonce: first.eventNonce ?? "",
		status: first.status,
	};
}

async function queryIris(
	attestationApiBase: string,
	sourceDomain: number,
	transactionHash: string,
): Promise<Attestation | undefined> {
	const url = `${attestationApiBase.replace(/\/$/, "")}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
	const response = await fetch(url);
	if (response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		throw new Error(`Iris query failed: ${response.status} ${response.statusText}`);
	}
	return parseIrisResponse(await response.json());
}

/**
 * Resolve a CCTP attestation for a burn transaction. In VCR replay mode returns
 * the recorded cassette immediately; otherwise bounded-polls Iris until the
 * message is `complete` or the deadline elapses (then throws). When recording,
 * the resolved attestation is written back to the replay directory.
 */
export async function fetchAttestation(
	options: FetchAttestationOptions,
): Promise<Attestation> {
	const {
		attestationApiBase,
		sourceDomain,
		transactionHash,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		now = Date.now,
		sleep = defaultSleep,
	} = options;

	const dir = replayDir();
	if (dir !== undefined && !isRecording()) {
		const cassette = await readCassette(dir, sourceDomain, transactionHash);
		if (cassette === undefined) {
			throw new Error(
				`No CCTP cassette for ${cassetteName(sourceDomain, transactionHash)} in ${dir} (record one with BENZO_CCTP_RECORD=1)`,
			);
		}
		return cassette;
	}

	const deadline = now() + timeoutMs;
	for (;;) {
		const attestation = await queryIris(
			attestationApiBase,
			sourceDomain,
			transactionHash,
		);
		if (attestation !== undefined) {
			if (dir !== undefined && isRecording()) {
				await writeCassette(dir, sourceDomain, transactionHash, attestation);
			}
			return attestation;
		}
		if (now() >= deadline) {
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for CCTP attestation of ${transactionHash} (domain ${sourceDomain})`,
			);
		}
		await sleep(pollIntervalMs);
	}
}
