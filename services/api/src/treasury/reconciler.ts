import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { Hex } from "viem";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { treasuryDeposits } from "../db/schema.js";

export const TREASURY_RECONCILE_QUEUE = "treasury.reconcile";
export const TREASURY_RECONCILE_GRACE_MS = 90_000;

const DEFAULT_RECONCILE_LIMIT = 50;

export type TreasuryReconcileJobData = {
	requestedAt: string;
};

type ReceiptStatus = "success" | "reverted" | `0x${string}` | number | bigint;

export type TreasuryReceipt = {
	status: ReceiptStatus;
};

export type TreasuryReceiptClient = {
	getTransactionReceipt: (input: {
		hash: Hex;
	}) => Promise<TreasuryReceipt | null>;
};

export type TreasuryReconcileOptions = {
	graceMs?: number;
	limit?: number;
	now?: () => number;
	receiptClient: TreasuryReceiptClient;
};

export type TreasuryReconcilerOptions = TreasuryReconcileOptions & {
	config: ApiConfig;
};

export type TreasuryReconcileResult = {
	confirmed: number;
	failed: number;
	pending: number;
	polled: number;
	skipped: number;
};

type Candidate = {
	id: string;
	txHash: string;
};

export async function handleTreasuryReconcileJob(
	db: Database,
	options: TreasuryReconcilerOptions,
): Promise<TreasuryReconcileResult> {
	return reconcileTreasuryDeposits(db, options);
}

export async function reconcileTreasuryDeposits(
	db: Database,
	options: TreasuryReconcileOptions,
): Promise<TreasuryReconcileResult> {
	const result: TreasuryReconcileResult = {
		confirmed: 0,
		failed: 0,
		pending: 0,
		polled: 0,
		skipped: 0,
	};
	const now = options.now?.() ?? Date.now();
	const cutoff = new Date(now - (options.graceMs ?? TREASURY_RECONCILE_GRACE_MS));
	const rows = await db
		.select({
			id: treasuryDeposits.id,
			txHash: treasuryDeposits.txHash,
		})
		.from(treasuryDeposits)
		.where(
			and(
				eq(treasuryDeposits.status, "submitted"),
				isNotNull(treasuryDeposits.txHash),
				lte(treasuryDeposits.updatedAt, cutoff),
			),
		)
		.orderBy(asc(treasuryDeposits.updatedAt))
		.limit(options.limit ?? DEFAULT_RECONCILE_LIMIT);

	for (const row of rows) {
		if (!row.txHash) {
			result.skipped += 1;
			continue;
		}

		result.polled += 1;
		const candidate = { id: row.id, txHash: row.txHash };
		const receipt = await getReceiptOrNull(options.receiptClient, candidate);
		if (!receipt) {
			result.pending += 1;
			continue;
		}

		const status = receiptStatusToDepositStatus(receipt.status);
		const settled = await settleSubmittedTreasuryDeposit(db, candidate, status);
		if (!settled) {
			result.skipped += 1;
			continue;
		}

		result[status] += 1;
	}

	return result;
}

async function getReceiptOrNull(
	client: TreasuryReceiptClient,
	candidate: Candidate,
): Promise<TreasuryReceipt | null> {
	try {
		return await client.getTransactionReceipt({
			hash: candidate.txHash as Hex,
		});
	} catch (error) {
		if (isReceiptNotFoundError(error)) {
			return null;
		}

		throw error;
	}
}

async function settleSubmittedTreasuryDeposit(
	db: Database,
	candidate: Candidate,
	status: "confirmed" | "failed",
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({
				id: treasuryDeposits.id,
				status: treasuryDeposits.status,
				txHash: treasuryDeposits.txHash,
			})
			.from(treasuryDeposits)
			.where(eq(treasuryDeposits.id, candidate.id))
			.for("update");

		if (
			!locked ||
			locked.status !== "submitted" ||
			!locked.txHash ||
			locked.txHash.toLowerCase() !== candidate.txHash.toLowerCase()
		) {
			return false;
		}

		await tx
			.update(treasuryDeposits)
			.set({ status, updatedAt: new Date() })
			.where(eq(treasuryDeposits.id, locked.id));
		return true;
	});
}

function receiptStatusToDepositStatus(
	status: ReceiptStatus,
): "confirmed" | "failed" {
	if (status === 1 || status === 1n) {
		return "confirmed";
	}

	if (status === 0 || status === 0n) {
		return "failed";
	}

	if (typeof status === "string") {
		const normalized = status.toLowerCase();
		if (normalized === "success" || normalized === "0x1" || normalized === "1") {
			return "confirmed";
		}
		if (normalized === "reverted" || normalized === "0x0" || normalized === "0") {
			return "failed";
		}
	}

	throw new Error(`unsupported_treasury_receipt_status:${String(status)}`);
}

function isReceiptNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	const fields = error as {
		details?: unknown;
		message?: unknown;
		name?: unknown;
		shortMessage?: unknown;
	};
	const text = [fields.name, fields.shortMessage, fields.message, fields.details]
		.filter((value): value is string => typeof value === "string")
		.join(" ");

	return /receipt/i.test(text) && /(not found|could not be found)/i.test(text);
}
