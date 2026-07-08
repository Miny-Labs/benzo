import { eq, inArray, sql } from "drizzle-orm";
import type {
	FastifyPluginAsync,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import { unsealString } from "../crypto/seal.js";
import type { Database } from "../db/client.js";
import {
	handles,
	orgTreasuries,
	payrollItems,
	payrollRuns,
	users,
	type OrgRole,
} from "../db/schema.js";
import { ROLE_RANK, loadMembership, makeRequireOrgRole } from "../orgs/access.js";
import {
	enqueuePayrollRun,
	getPayrollProgressCounts,
	parsePayrollAmount,
} from "../payroll/runner.js";
import type { PayrollSubmitter } from "../payroll/chain.js";
import {
	deserializeManagedEercAccount,
	getDecryptedBalance,
} from "../payroll/eerc.js";

type PayrollRoutesOptions = {
	boss: PgBoss;
	config: ApiConfig;
	db: Database;
	payrollSubmitter: PayrollSubmitter;
};

const intakeSchema = z.object({
	// Raw CSV text: rows of `recipient,amount`. Recipient is a `@handle`
	// (resolved via the handles table) or a raw 0x address. Amount is a decimal
	// string in the selected payroll token units (6 decimals).
	csv: z.string().min(1).max(1_000_000),
	token: z.enum(["usdc", "eurc"]).default("usdc"),
});

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Positive decimal with at most 6 fractional digits (tUSDC precision).
const AMOUNT = /^\d+(\.\d{1,6})?$/;
// Cap recipients per run (a payroll of tens of thousands is a mistake, and it
// bounds the downstream proving work).
const MAX_ROWS = 10_000;
// Postgres binds one parameter per value; keep every query well under the
// 65,535 wire-protocol limit. payroll_items binds ~7 values per row.
const ITEM_INSERT_BATCH = 5_000;
const QUERY_BATCH = 10_000;

const chunk = <T>(arr: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		out.push(arr.slice(i, i + size));
	}
	return out;
};

type ParsedRow = {
	rowIndex: number;
	recipientInput: string;
	amount: string;
};

type PreviewItem = {
	rowIndex: number;
	recipientInput: string;
	resolvedAddress: string | null;
	amount: string;
	status: "pending" | "failed";
	error: string | null;
};

const isPositive = (amount: string): boolean => {
	// AMOUNT already constrains the shape; reject an all-zero value like "0.000".
	return /[1-9]/.test(amount);
};

// Parse CSV text into rows, skipping blank lines and an optional header. The
// header is the FIRST non-empty line whose amount column isn't numeric — keyed
// to content, not raw line index, so leading blank lines don't hide it.
const parseCsv = (csv: string): ParsedRow[] => {
	const rows: ParsedRow[] = [];
	let rowIndex = 0;
	let firstContentSeen = false;
	for (const raw of csv.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") {
			continue;
		}
		const cols = line.split(",").map((c) => c.trim());
		const recipientInput = cols[0] ?? "";
		const amount = cols[1] ?? "";
		if (!firstContentSeen) {
			firstContentSeen = true;
			if (!AMOUNT.test(amount)) {
				continue;
			}
		}
		rows.push({ rowIndex: rowIndex++, recipientInput, amount });
	}
	return rows;
};

export const payrollRoutes: FastifyPluginAsync<PayrollRoutesOptions> = async (
	fastify,
	options,
) => {
	const { db } = options;
	const requireOrgRole = makeRequireOrgRole(fastify, db);

	// POST /orgs/:id/payroll — validate a CSV into a ready-to-run payroll draft.
	fastify.post(
		"/orgs/:id/payroll",
		{ preHandler: requireOrgRole("operator") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const body = intakeSchema.safeParse(request.body);
			if (!body.success) {
				return reply.code(400).send({ error: "invalid_payroll" });
			}
			const payrollToken = resolvePayrollToken(
				options.config,
				body.data.token,
			);
			if (!payrollToken) {
				return reply.code(503).send({ error: "payroll_token_not_configured" });
			}

			const parsed = parseCsv(body.data.csv);
			if (parsed.length === 0) {
				return reply.code(400).send({ error: "empty_payroll" });
			}
			if (parsed.length > MAX_ROWS) {
				return reply
					.code(400)
					.send({ error: "too_many_rows", maxRows: MAX_ROWS });
			}

			// Batch-resolve @handles to wallet addresses. Dedupe the handles and
			// chunk the lookup so the IN clause never exceeds Postgres's 65,535
			// bind-parameter limit on a large CSV.
			const handleInputs = [
				...new Set(
					parsed
						.map((r) => r.recipientInput)
						.filter((r) => r !== "" && !EVM_ADDRESS.test(r))
						.map((r) => r.replace(/^@/, "").toLowerCase()),
				),
			];
			const handleToAddress = new Map<string, string>();
			for (const group of chunk(handleInputs, QUERY_BATCH)) {
				const found = await db
					.select({ handle: handles.handle, address: users.address })
					.from(handles)
					.innerJoin(users, eq(handles.userId, users.id))
					.where(inArray(handles.handle, group));
				for (const row of found) {
					handleToAddress.set(row.handle.toLowerCase(), row.address);
				}
			}

			// Validate each row; dedupe by resolved address.
			const seen = new Set<string>();
			const items: PreviewItem[] = parsed.map((row) => {
				const base = {
					rowIndex: row.rowIndex,
					recipientInput: row.recipientInput,
					amount: row.amount,
				};
				const fail = (error: string): PreviewItem => ({
					...base,
					resolvedAddress: null,
					status: "failed",
					error,
				});

				let resolvedAddress: string | null = null;
				if (EVM_ADDRESS.test(row.recipientInput)) {
					resolvedAddress = row.recipientInput.toLowerCase();
				} else if (row.recipientInput !== "") {
					const key = row.recipientInput.replace(/^@/, "").toLowerCase();
					resolvedAddress = handleToAddress.get(key) ?? null;
					if (resolvedAddress === null) {
						return fail("unknown_recipient");
					}
				} else {
					return fail("missing_recipient");
				}

				if (!AMOUNT.test(row.amount) || !isPositive(row.amount)) {
					return { ...base, resolvedAddress, status: "failed", error: "invalid_amount" };
				}
				if (seen.has(resolvedAddress)) {
					return { ...base, resolvedAddress, status: "failed", error: "duplicate_recipient" };
				}
				seen.add(resolvedAddress);
				return { ...base, resolvedAddress, status: "pending", error: null };
			});

			const validItems = items.filter((i) => i.status === "pending");
			const totalAmount = sumAmounts(validItems.map((i) => i.amount));

			// Persist the run + items atomically.
			const run = await db.transaction(async (tx) => {
				const [created] = await tx
					.insert(payrollRuns)
					.values({
						orgId,
						status: validItems.length > 0 ? "ready" : "failed",
						itemCount: validItems.length,
						totalAmount,
						token: payrollToken.token,
						tokenId: payrollToken.tokenId,
						createdBy: request.user!.id,
						error: validItems.length > 0 ? null : "no_valid_rows",
					})
					.returning();
				const runId = created!.id;
				const rows = items.map((i) => ({
					runId,
					rowIndex: i.rowIndex,
					recipientInput: i.recipientInput,
					resolvedAddress: i.resolvedAddress,
					amount: i.amount,
					status: i.status,
					error: i.error,
				}));
				// Chunk so a large run never exceeds Postgres's 65,535 bind-param
				// cap (payroll_items binds ~7 values per row).
				for (const group of chunk(rows, ITEM_INSERT_BATCH)) {
					await tx.insert(payrollItems).values(group);
				}
				return created;
			});

			return reply.code(201).send({
				runId: run!.id,
				status: run!.status,
				token: run!.token,
				tokenId: run!.tokenId.toString(),
				summary: {
					total: items.length,
					valid: validItems.length,
					invalid: items.length - validItems.length,
					totalAmount,
					token: run!.token,
					tokenId: run!.tokenId.toString(),
				},
				items,
			});
		},
	);

	// GET /payroll/:runId — run detail + items, for any member of the run's org.
	// If requested as text/event-stream, it streams live progress counts.
	fastify.get(
		"/payroll/:runId",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const runId = (request.params as { runId: string }).runId;
			if (!z.uuid().safeParse(runId).success) {
				return reply.code(400).send({ error: "invalid_run_id" });
			}

			const access = await loadRunForRole(db, runId, request.user!.id, "viewer");
			if ("error" in access) {
				return reply.code(access.code).send({ error: access.error });
			}

			if (request.headers.accept?.includes("text/event-stream")) {
				return streamPayrollProgress(db, runId, request, reply);
			}

			return reply.send(await loadRunPayload(db, runId, access.run));
		},
	);

	fastify.post(
		"/payroll/:runId/start",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const runId = (request.params as { runId: string }).runId;
			if (!z.uuid().safeParse(runId).success) {
				return reply.code(400).send({ error: "invalid_run_id" });
			}

			const access = await loadRunForRole(db, runId, request.user!.id, "operator");
			if ("error" in access) {
				return reply.code(access.code).send({ error: access.error });
			}
			const { run } = access;
			if (!["ready", "paused", "running"].includes(run.status)) {
				return reply.code(409).send({ error: "run_not_startable" });
			}

			const [treasury] = await db
				.select({
					address: orgTreasuries.address,
					registered: sql<boolean>`${orgTreasuries.eercRegisteredAt} is not null`,
					sealedEercKey: orgTreasuries.sealedEercKey,
				})
				.from(orgTreasuries)
				.where(eq(orgTreasuries.orgId, run.orgId))
				.limit(1);
			if (!treasury?.registered || !treasury.sealedEercKey) {
				return reply.code(409).send({ error: "treasury_not_eerc_registered" });
			}
			if (run.status === "ready") {
				let funding: Awaited<ReturnType<typeof loadRunFundingStatus>>;
				try {
					funding = await loadRunFundingStatus({
						config: options.config,
						sealedEercKey: treasury.sealedEercKey,
						submitter: options.payrollSubmitter,
						treasuryAddress: treasury.address,
						run,
					});
				} catch (error) {
					request.log.error(
						{ err: error, runId },
						"payroll treasury balance lookup failed",
					);
					return reply
						.code(502)
						.send({ error: "treasury_balance_unavailable" });
				}
				if (!funding.funded) {
					return reply.code(409).send({
						availableAmount: funding.availableAmount,
						error: "treasury_underfunded",
						requiredAmount: run.totalAmount,
						token: run.token,
						tokenId: run.tokenId.toString(),
					});
				}
			}

			await db
				.update(payrollRuns)
				.set({ error: null, status: "running", updatedAt: new Date() })
				.where(eq(payrollRuns.id, runId));
			const enqueued = await enqueuePayrollRun(db, options.boss, runId);

			return reply.code(202).send({
				enqueued: enqueued.enqueued,
				progress: await getPayrollProgressCounts(db, runId),
				runId,
				status: "running",
				totalPending: enqueued.totalPending,
			});
		},
	);

	fastify.post(
		"/payroll/:runId/pause",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const runId = (request.params as { runId: string }).runId;
			if (!z.uuid().safeParse(runId).success) {
				return reply.code(400).send({ error: "invalid_run_id" });
			}

			const access = await loadRunForRole(db, runId, request.user!.id, "operator");
			if ("error" in access) {
				return reply.code(access.code).send({ error: access.error });
			}
			const { run } = access;
			if (run.status === "complete" || run.status === "failed") {
				return reply.code(409).send({ error: "run_terminal" });
			}

			await db
				.update(payrollRuns)
				.set({ status: "paused", updatedAt: new Date() })
				.where(eq(payrollRuns.id, runId));

			return reply.send({
				progress: await getPayrollProgressCounts(db, runId),
				runId,
				status: "paused",
			});
		},
	);

	fastify.post(
		"/payroll/:runId/resume",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const runId = (request.params as { runId: string }).runId;
			if (!z.uuid().safeParse(runId).success) {
				return reply.code(400).send({ error: "invalid_run_id" });
			}

			const access = await loadRunForRole(db, runId, request.user!.id, "operator");
			if ("error" in access) {
				return reply.code(access.code).send({ error: access.error });
			}
			const { run } = access;
			if (run.status !== "paused") {
				return reply.code(409).send({ error: "run_not_paused" });
			}

			await db
				.update(payrollRuns)
				.set({ error: null, status: "running", updatedAt: new Date() })
				.where(eq(payrollRuns.id, runId));
			const enqueued = await enqueuePayrollRun(db, options.boss, runId);

			return reply.code(202).send({
				enqueued: enqueued.enqueued,
				progress: await getPayrollProgressCounts(db, runId),
				runId,
				status: "running",
				totalPending: enqueued.totalPending,
			});
		},
	);
};

// Sum decimal amount strings without float error (scale to 6-decimal integers).
function sumAmounts(amounts: string[]): string {
	let scaled = 0n;
	for (const a of amounts) {
		const [whole, frac = ""] = a.split(".");
		const fracPadded = (frac + "000000").slice(0, 6);
		scaled += BigInt(whole ?? "0") * 1_000_000n + BigInt(fracPadded || "0");
	}
	const whole = scaled / 1_000_000n;
	const frac = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
	return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

async function loadRunForRole(
	db: Database,
	runId: string,
	userId: string,
	minRole: OrgRole,
): Promise<
	| { run: typeof payrollRuns.$inferSelect }
	| { code: 403 | 404; error: "forbidden" | "run_not_found" }
> {
	const [run] = await db
		.select()
		.from(payrollRuns)
		.where(eq(payrollRuns.id, runId))
		.limit(1);
	if (!run) {
		return { code: 404, error: "run_not_found" };
	}

	const role = await loadMembership(db, run.orgId, userId);
	if (role === null) {
		return { code: 404, error: "run_not_found" };
	}
	if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
		return { code: 403, error: "forbidden" };
	}

	return { run };
}

async function loadRunPayload(
	db: Database,
	runId: string,
	run: typeof payrollRuns.$inferSelect,
) {
	const runItems = await db
		.select()
		.from(payrollItems)
		.where(eq(payrollItems.runId, runId))
		.orderBy(payrollItems.rowIndex);

	return {
		items: runItems,
		progress: await getPayrollProgressCounts(db, runId),
		run: serializePayrollRun(run),
	};
}

async function streamPayrollProgress(
	db: Database,
	runId: string,
	request: FastifyRequest,
	reply: FastifyReply,
) {
	reply.hijack();
	reply.raw.writeHead(200, {
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"content-type": "text/event-stream",
		"x-accel-buffering": "no",
	});

	const sendProgress = async (): Promise<boolean> => {
		const [run] = await db
			.select()
			.from(payrollRuns)
			.where(eq(payrollRuns.id, runId))
			.limit(1);
		if (!run) {
			reply.raw.write(
				`event: terminal\ndata: ${JSON.stringify({ error: "run_not_found" })}\n\n`,
			);
			return true;
		}

		const progress = await getPayrollProgressCounts(db, runId);
		reply.raw.write(
			`event: progress\ndata: ${JSON.stringify({
				progress,
				runId,
				status: run.status,
			})}\n\n`,
		);

		return run.status === "complete" || run.status === "failed";
	};

	let closed = false;
	let interval: ReturnType<typeof setInterval> | undefined;
	const close = (): void => {
		if (closed) {
			return;
		}
		closed = true;
		if (interval) {
			clearInterval(interval);
			interval = undefined;
		}
		reply.raw.end();
	};

	request.raw.on("close", () => {
		closed = true;
		if (interval) {
			clearInterval(interval);
			interval = undefined;
		}
	});

	try {
		if (await sendProgress()) {
			close();
			return;
		}
		let progressInFlight = false;
		interval = setInterval(() => {
			if (progressInFlight) {
				return;
			}
			progressInFlight = true;
			void sendProgress()
				.then((done) => {
					if (done) {
						close();
					}
				})
				.catch((error: unknown) => {
					request.log.error({ err: error }, "payroll sse failed");
					close();
				})
				.finally(() => {
					progressInFlight = false;
				});
		}, 2_000);
	} catch (error) {
		request.log.error({ err: error }, "payroll sse failed");
		close();
	}
}

type PayrollToken = "usdc" | "eurc";

function resolvePayrollToken(
	config: ApiConfig,
	token: PayrollToken,
): { token: PayrollToken; tokenId: bigint } | null {
	const configured = config.treasuryFundingTokens.find(
		(entry) => entry.token === token,
	);
	if (configured) {
		return { token, tokenId: configured.tokenId };
	}

	if (token === "usdc") {
		return { token, tokenId: config.payrollTokenId };
	}

	return null;
}

async function loadRunFundingStatus({
	config,
	run,
	sealedEercKey,
	submitter,
	treasuryAddress,
}: {
	config: ApiConfig;
	run: typeof payrollRuns.$inferSelect;
	sealedEercKey: Buffer;
	submitter: PayrollSubmitter;
	treasuryAddress: string;
}): Promise<{ availableAmount: string; funded: boolean }> {
	const account = deserializeManagedEercAccount(
		unsealString(config.appMasterKey, sealedEercKey),
	);
	const balance = await submitter.loadTreasuryBalance({
		tokenId: run.tokenId,
		treasuryAddress,
	});
	const available = getDecryptedBalance(account.privateKey, balance);
	const required = parsePayrollAmount(
		run.totalAmount,
		config.payrollEercDecimals,
	);

	return {
		availableAmount: formatPayrollAmount(available, config.payrollEercDecimals),
		funded: available >= required,
	};
}

function formatPayrollAmount(amount: bigint, decimals: number): string {
	if (decimals <= 0) {
		return amount.toString();
	}

	const scale = 10n ** BigInt(decimals);
	const whole = amount / scale;
	const fraction = (amount % scale)
		.toString()
		.padStart(decimals, "0")
		.replace(/0+$/, "");
	return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

function serializePayrollRun(run: typeof payrollRuns.$inferSelect) {
	return {
		...run,
		tokenId: run.tokenId.toString(),
	};
}
