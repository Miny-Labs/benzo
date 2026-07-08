import { z } from "zod";

// Typed Circle Iris (CCTP V2 attestation service) client. It performs a single
// bounded request per call and returns the parsed messages; it does NOT sleep,
// poll, or retry — the relayer job (#111) owns the polling cadence and backoff.

const irisMessageSchema = z.object({
	// The raw CCTP message bytes and its attestation. Both are absent while the
	// burn is still gathering confirmations, so they are nullable.
	message: z.string().nullable().optional(),
	attestation: z.string().nullable().optional(),
	eventNonce: z.string().nullable().optional(),
	// "pending_confirmations" until finality, then "complete".
	status: z.string(),
	decodedMessage: z.record(z.string(), z.unknown()).nullable().optional(),
	cctpVersion: z.number().nullable().optional(),
});

const irisResponseSchema = z.object({
	messages: z.array(irisMessageSchema).default([]),
});

export type IrisMessage = z.infer<typeof irisMessageSchema>;

export type IrisClient = {
	/**
	 * Fetch the CCTP message(s) emitted by a burn transaction on `sourceDomain`.
	 * Returns an empty array when Iris has not indexed the tx yet (404). Throws
	 * `iris_request_failed:<status>` on any other non-2xx response.
	 */
	getMessages: (
		sourceDomain: number,
		transactionHash: string,
	) => Promise<IrisMessage[]>;
};

export type CreateIrisClientOptions = {
	attestationApiBase: string;
	// Injectable for tests; defaults to the global fetch.
	fetchImpl?: typeof fetch;
	// Per-request bound; the request is aborted after this many ms.
	timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function createIrisClient(
	options: CreateIrisClientOptions,
): IrisClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const base = options.attestationApiBase.replace(/\/+$/, "");

	return {
		async getMessages(sourceDomain, transactionHash) {
			const url = `${base}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(
				transactionHash,
			)}`;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);

			let response: Response;
			try {
				response = await fetchImpl(url, {
					headers: { accept: "application/json" },
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			// Iris returns 404 until it has indexed the burn tx — that is a normal
			// "not ready yet" state, not an error.
			if (response.status === 404) {
				return [];
			}

			if (!response.ok) {
				throw new Error(`iris_request_failed:${response.status}`);
			}

			const parsed = irisResponseSchema.parse(await response.json());
			return parsed.messages;
		},
	};
}
