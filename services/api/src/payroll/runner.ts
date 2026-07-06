import { and, eq, inArray, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { Hex } from "viem";
import type { ApiConfig } from "../config.js";
import { sealString, unsealString } from "../crypto/seal.js";
import type { Database } from "../db/client.js";
import {
	eventLinks,
	orgTreasuries,
	payrollItems,
	payrollRuns,
	type PayrollItemStatus,
	type PayrollRunStatus,
} from "../db/schema.js";
import type { PayrollSubmitter } from "./chain.js";
import {
	buildTransferProofInput,
	deserializeManagedEercAccount,
} from "./eerc.js";
import type { PayrollProver } from "./prover.js";

export const PAYROLL_ITEM_QUEUE = "payroll.item";
export const PAYROLL_CONFIRMATIONS = 2;
export const PAYROLL_MAX_ATTEMPTS = 5;

const activeItemStatuses: PayrollItemStatus[] = [
	"pending",
	"proving",
	"submitted",
];

export type PayrollItemJobData = {
	itemId: string;
	orgId: string;
	rowIndex: number;
	runId: string;
	singletonKey: string;
};

export type PayrollWorkerOptions = {
	config: ApiConfig;
	pool: Pool;
	prover: PayrollProver;
	submitter: PayrollSubmitter;
};

export type PayrollProgressCounts = {
	confirmed: number;
	failed: number;
	pending: number;
	proved: number;
	proving: number;
	submitted: number;
	total: number;
};

export async function enqueuePayrollRun(
	db: Database,
	boss: PgBoss,
	runId: string,
): Promise<{ enqueued: number; totalPending: number }> {
	const items = await db
		.select({
			id: payrollItems.id,
			orgId: payrollRuns.orgId,
			rowIndex: payrollItems.rowIndex,
			runId: payrollItems.runId,
		})
		.from(payrollItems)
		.innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
		.where(
			and(
				eq(payrollItems.runId, runId),
				inArray(payrollItems.status, activeItemStatuses),
			),
		)
		.orderBy(payrollItems.rowIndex);

	let enqueued = 0;
	for (const item of items) {
		const jobId = await enqueuePayrollItem(boss, {
			itemId: item.id,
			orgId: item.orgId,
			rowIndex: item.rowIndex,
			runId: item.runId,
			singletonKey: payrollSingletonKey(item.runId, item.rowIndex),
		});
		if (jobId !== null) {
			enqueued += 1;
		}
	}

	return { enqueued, totalPending: items.length };
}

export async function enqueueOutstandingPayrollItems(
	db: Database,
	boss: PgBoss,
): Promise<number> {
	const runs = await db
		.select({ id: payrollRuns.id })
		.from(payrollRuns)
		.where(eq(payrollRuns.status, "running"));

	let enqueued = 0;
	for (const run of runs) {
		enqueued += (await enqueuePayrollRun(db, boss, run.id)).enqueued;
	}

	return enqueued;
}

export async function handlePayrollItemJob(
	db: Database,
	options: PayrollWorkerOptions,
	job: Job<PayrollItemJobData>,
): Promise<void> {
	await withOrgPayrollLock(options.pool, job.data.orgId, async () => {
		await processPayrollItem(db, options, job.data);
	});
}

export async function getPayrollProgressCounts(
	db: Database,
	runId: string,
): Promise<PayrollProgressCounts> {
	const rows = await db
		.select({
			count: sql<number>`count(*)::int`,
			status: payrollItems.status,
		})
		.from(payrollItems)
		.where(eq(payrollItems.runId, runId))
		.groupBy(payrollItems.status);
	const counts: PayrollProgressCounts = {
		confirmed: 0,
		failed: 0,
		pending: 0,
		proved: 0,
		proving: 0,
		submitted: 0,
		total: 0,
	};

	for (const row of rows) {
		const count = Number(row.count);
		counts[row.status] = count;
		counts.total += count;
	}
	counts.proved = counts.confirmed;

	return counts;
}

async function enqueuePayrollItem(
	boss: PgBoss,
	data: PayrollItemJobData,
): Promise<string | null> {
	return boss.send(PAYROLL_ITEM_QUEUE, data, {
		singletonKey: data.singletonKey,
		singletonSeconds: 2_592_000,
	});
}

async function processPayrollItem(
	db: Database,
	options: PayrollWorkerOptions,
	data: PayrollItemJobData,
): Promise<void> {
	const row = await loadRunnableItem(db, data.itemId);
	if (!row) {
		return;
	}

	if (row.run.status === "paused") {
		return;
	}

	if (row.run.status !== "running" && row.run.status !== "ready") {
		return;
	}

	if (row.item.status === "confirmed" || row.item.status === "failed") {
		await finalizeRunIfSettled(db, row.run.id);
		return;
	}

	if (row.item.status === "submitted" || row.item.txHash) {
		if (!row.item.txHash) {
			await markSubmittedItemUnreconciled(db, row.item.id);
			return;
		}
		await confirmSubmittedItem(
			db,
			options,
			row.item.id,
			row.run.id,
			row.item.rowIndex,
			row.item.txHash as Hex,
			row.item.submissionRawTx
				? (unsealString(
						options.config.appMasterKey,
						row.item.submissionRawTx,
					) as Hex)
				: null,
		);
		return;
	}

	if (!row.item.resolvedAddress) {
		await markItemFailed(db, row.item.id, "missing_resolved_address");
		await finalizeRunIfSettled(db, row.run.id);
		return;
	}

	if (row.item.attempt >= PAYROLL_MAX_ATTEMPTS) {
		await markItemFailed(db, row.item.id, "max_attempts_exceeded");
		await finalizeRunIfSettled(db, row.run.id);
		return;
	}

	await db
		.update(payrollRuns)
		.set({ status: "running", updatedAt: new Date() })
		.where(eq(payrollRuns.id, row.run.id));

	const [started] = await db
		.update(payrollItems)
		.set({
			attempt: row.item.attempt + 1,
			error: null,
			status: "proving",
			updatedAt: new Date(),
		})
		.where(eq(payrollItems.id, row.item.id))
		.returning({
			attempt: payrollItems.attempt,
		});

	let prepared: { rawTransaction: Hex; txHash: Hex };
	try {
		const treasury = await loadTreasury(db, row.run.orgId);
		const eoaPrivateKey = unsealString(
			options.config.appMasterKey,
			treasury.sealedEoaKey,
		) as Hex;
		const eercAccount = deserializeManagedEercAccount(
			unsealString(options.config.appMasterKey, treasury.sealedEercKey),
		);
		const amount = parsePayrollAmount(
			row.item.amount,
			options.config.payrollEercDecimals,
		);
		const context = await options.submitter.loadTransferContext({
			recipientAddress: row.item.resolvedAddress,
			sender: eercAccount,
			tokenId: options.config.payrollTokenId,
			treasuryAddress: treasury.address,
		});
		const built = buildTransferProofInput({
			auditorPublicKey: context.auditorPublicKey,
			receiverPublicKey: context.receiverPublicKey,
			sender: eercAccount,
			senderBalance: context.senderBalance,
			senderEncryptedBalance: context.senderEncryptedBalance,
			transferAmount: amount,
		});
		const proof = await options.prover.proveTransfer(built.input);

		prepared = await options.submitter.prepareTransfer({
			balancePCT: built.senderBalancePCT,
			eoaPrivateKey,
			proof,
			recipientAddress: row.item.resolvedAddress,
			tokenId: options.config.payrollTokenId,
		});
		await db
			.update(payrollItems)
			.set({
				error: null,
				status: "submitted",
				submissionRawTx: sealString(
					options.config.appMasterKey,
					prepared.rawTransaction,
				),
				txHash: prepared.txHash,
				updatedAt: new Date(),
			})
			.where(eq(payrollItems.id, row.item.id));
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "payroll_item_failed";
		const attempt = started?.attempt ?? row.item.attempt + 1;
		await db
			.update(payrollItems)
			.set({
				error: message,
				status: attempt >= PAYROLL_MAX_ATTEMPTS ? "failed" : "pending",
				updatedAt: new Date(),
			})
			.where(eq(payrollItems.id, row.item.id));
		await finalizeRunIfSettled(db, row.run.id);
		if (attempt < PAYROLL_MAX_ATTEMPTS) {
			throw new Error(message);
		}
		return;
	}

	await confirmSubmittedItem(
		db,
		options,
		row.item.id,
		row.run.id,
		row.item.rowIndex,
		prepared.txHash,
		prepared.rawTransaction,
	);
}

async function confirmSubmittedItem(
	db: Database,
	options: PayrollWorkerOptions,
	itemId: string,
	runId: string,
	rowIndex: number,
	txHash: Hex,
	rawTransaction: Hex | null,
): Promise<void> {
	await db
		.update(payrollItems)
		.set({
			error: null,
			status: "submitted",
			...(rawTransaction
				? {
						submissionRawTx: sealString(
							options.config.appMasterKey,
							rawTransaction,
						),
					}
				: {}),
			txHash,
			updatedAt: new Date(),
		})
		.where(eq(payrollItems.id, itemId));
	try {
		if (rawTransaction) {
			await options.submitter.submitPreparedTransfer({
				rawTransaction,
				txHash,
			});
		}
		await options.submitter.waitForConfirmations(txHash, PAYROLL_CONFIRMATIONS);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "payroll_confirmation_failed";
		if (message === "transfer_reverted") {
			await markItemFailed(db, itemId, message);
			await finalizeRunIfSettled(db, runId);
			return;
		}
		await db
			.update(payrollItems)
			.set({
				confirmationAttempt: sql`${payrollItems.confirmationAttempt} + 1`,
				error: message,
				status: "submitted",
				txHash,
				updatedAt: new Date(),
			})
			.where(eq(payrollItems.id, itemId));
		throw new Error(message);
	}
	await db.transaction(async (tx) => {
		await tx
			.update(payrollItems)
			.set({
				confirmationAttempt: 0,
				error: null,
				status: "confirmed",
				submissionRawTx: null,
				txHash,
				updatedAt: new Date(),
			})
			.where(eq(payrollItems.id, itemId));
		await tx
			.insert(eventLinks)
			.values({
				label: `Payroll ${runId} row ${rowIndex}`,
				objectId: runId,
				objectType: "payroll_items",
				txHash,
			})
			.onConflictDoNothing();
	});
	await finalizeRunIfSettled(db, runId);
}

async function finalizeRunIfSettled(
	db: Database,
	runId: string,
): Promise<void> {
	const counts = await getPayrollProgressCounts(db, runId);
	if (counts.pending > 0 || counts.proving > 0 || counts.submitted > 0) {
		return;
	}

	const nextStatus: PayrollRunStatus =
		counts.confirmed > 0 ? "complete" : "failed";
	await db
		.update(payrollRuns)
		.set({
			error: nextStatus === "failed" ? "no_confirmed_items" : null,
			status: nextStatus,
			updatedAt: new Date(),
		})
		.where(eq(payrollRuns.id, runId));
}

async function markItemFailed(
	db: Database,
	itemId: string,
	error: string,
): Promise<void> {
	await db
		.update(payrollItems)
		.set({
			error,
			status: "failed",
			submissionRawTx: null,
			updatedAt: new Date(),
		})
		.where(eq(payrollItems.id, itemId));
}

async function markSubmittedItemUnreconciled(
	db: Database,
	itemId: string,
): Promise<void> {
	await db
		.update(payrollItems)
		.set({
			error: "submitted_item_missing_tx_hash",
			status: "submitted",
			updatedAt: new Date(),
		})
		.where(eq(payrollItems.id, itemId));
}

async function loadTreasury(db: Database, orgId: string) {
	const [treasury] = await db
		.select({
			address: orgTreasuries.address,
			sealedEercKey: orgTreasuries.sealedEercKey,
			sealedEoaKey: orgTreasuries.sealedEoaKey,
		})
		.from(orgTreasuries)
		.where(eq(orgTreasuries.orgId, orgId))
		.limit(1);

	if (!treasury) {
		throw new Error("treasury_not_found");
	}
	if (!treasury.sealedEercKey) {
		throw new Error("treasury_not_eerc_registered");
	}

	return {
		...treasury,
		sealedEercKey: treasury.sealedEercKey,
	};
}

async function loadRunnableItem(db: Database, itemId: string) {
	const [row] = await db
		.select({
			item: payrollItems,
			run: payrollRuns,
		})
		.from(payrollItems)
		.innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
		.where(eq(payrollItems.id, itemId))
		.limit(1);

	return row ?? null;
}

async function withOrgPayrollLock<T>(
	pool: Pool,
	orgId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	const key = `payroll:${orgId}`;
	try {
		await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
			key,
		]);
		return await fn();
	} finally {
		await client
			.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
			.catch(() => undefined);
		client.release();
	}
}

function payrollSingletonKey(runId: string, rowIndex: number): string {
	return `${runId}:${rowIndex}`;
}

function parsePayrollAmount(amount: string, decimals: number): bigint {
	if (decimals < 0 || !Number.isInteger(decimals)) {
		throw new Error("invalid_payroll_decimals");
	}
	if (!/^\d+(?:\.\d*)?$/.test(amount)) {
		throw new Error("invalid_payroll_amount");
	}
	const [whole = "0", fraction = ""] = amount.split(".");
	if (fraction.length > decimals) {
		throw new Error("payroll_amount_exceeds_decimals");
	}
	const padded = fraction.padEnd(decimals, "0");
	return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}
