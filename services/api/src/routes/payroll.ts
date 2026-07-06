import { eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import {
	handles,
	payrollItems,
	payrollRuns,
	users,
} from "../db/schema.js";
import { loadMembership, makeRequireOrgRole } from "../orgs/access.js";

type PayrollRoutesOptions = {
	db: Database;
};

const intakeSchema = z.object({
	// Raw CSV text: rows of `recipient,amount`. Recipient is a `@handle`
	// (resolved via the handles table) or a raw 0x address. Amount is a decimal
	// string in token units (tUSDC, 6 decimals).
	csv: z.string().min(1).max(1_000_000),
});

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Positive decimal with at most 6 fractional digits (tUSDC precision).
const AMOUNT = /^\d+(\.\d{1,6})?$/;

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

			const parsed = parseCsv(body.data.csv);
			if (parsed.length === 0) {
				return reply.code(400).send({ error: "empty_payroll" });
			}

			// Batch-resolve @handles to wallet addresses in one query.
			const handleInputs = parsed
				.map((r) => r.recipientInput)
				.filter((r) => r !== "" && !EVM_ADDRESS.test(r))
				.map((r) => r.replace(/^@/, "").toLowerCase());
			const handleToAddress = new Map<string, string>();
			if (handleInputs.length > 0) {
				const found = await db
					.select({ handle: handles.handle, address: users.address })
					.from(handles)
					.innerJoin(users, eq(handles.userId, users.id))
					.where(inArray(handles.handle, handleInputs));
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
						createdBy: request.user!.id,
						error: validItems.length > 0 ? null : "no_valid_rows",
					})
					.returning();
				const runId = created!.id;
				await tx.insert(payrollItems).values(
					items.map((i) => ({
						runId,
						rowIndex: i.rowIndex,
						recipientInput: i.recipientInput,
						resolvedAddress: i.resolvedAddress,
						amount: i.amount,
						status: i.status,
						error: i.error,
					})),
				);
				return created;
			});

			return reply.code(201).send({
				runId: run!.id,
				status: run!.status,
				summary: {
					total: items.length,
					valid: validItems.length,
					invalid: items.length - validItems.length,
					totalAmount,
				},
				items,
			});
		},
	);

	// GET /payroll/:runId — run detail + items, for any member of the run's org.
	fastify.get(
		"/payroll/:runId",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const runId = (request.params as { runId: string }).runId;
			if (!z.uuid().safeParse(runId).success) {
				return reply.code(400).send({ error: "invalid_run_id" });
			}

			const [run] = await db
				.select()
				.from(payrollRuns)
				.where(eq(payrollRuns.id, runId))
				.limit(1);
			if (!run) {
				return reply.code(404).send({ error: "run_not_found" });
			}

			// Any org member may view a run. 404 (not 403) to non-members so
			// run/org existence isn't leaked. viewer is the lowest rank, so
			// membership alone is sufficient.
			const role = await loadMembership(db, run.orgId, request.user!.id);
			if (role === null) {
				return reply.code(404).send({ error: "run_not_found" });
			}

			const runItems = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.runId, runId))
				.orderBy(payrollItems.rowIndex);

			return reply.send({ run, items: runItems });
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
