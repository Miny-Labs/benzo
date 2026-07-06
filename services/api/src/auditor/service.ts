import {
	and,
	desc,
	eq,
	gte,
	isNotNull,
	lte,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { auditLog, auditorKeys, events } from "../db/schema.js";
import { unsealString } from "../crypto/seal.js";
import { decryptAuditorAmountPct } from "./crypto.js";

export type AuditorEventRow = {
	amount: string;
	auditorKeyId: string;
	blockNumber: string;
	blockTime: string;
	eventName: string;
	fromAddr: string | null;
	id: string;
	logIndex: number;
	toAddr: string | null;
	txHash: string;
};

export type AuditorReport = {
	address: string;
	eventCount: number;
	fromBlock: string | null;
	inflow: string;
	outflow: string;
	toBlock: string | null;
};

type ListAuditorEventsInput = {
	actor: string;
	address?: string;
	fromBlock?: bigint;
	limit: number;
	offset: number;
	toBlock?: bigint;
};

type BuildAuditorReportInput = {
	actor: string;
	address: string;
	fromBlock?: bigint;
	toBlock?: bigint;
};

type EventRow = typeof events.$inferSelect;
type AuditorKeyRow = typeof auditorKeys.$inferSelect;

export async function listAuditorEvents(
	db: Database,
	config: ApiConfig,
	input: ListAuditorEventsInput,
): Promise<{
	events: AuditorEventRow[];
	limit: number;
	nextOffset: number | null;
	offset: number;
}> {
	const rows = await db
		.select()
		.from(events)
		.where(auditorEventFilter(input))
		.orderBy(desc(events.blockNumber), desc(events.logIndex))
		.limit(input.limit + 1)
		.offset(input.offset);
	const visibleRows = rows.slice(0, input.limit);
	const decrypted = await decryptRows(db, config, input.actor, visibleRows);

	return {
		events: decrypted,
		limit: input.limit,
		nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
		offset: input.offset,
	};
}

export async function buildAuditorReport(
	db: Database,
	config: ApiConfig,
	input: BuildAuditorReportInput,
): Promise<AuditorReport> {
	const rows = await db
		.select()
		.from(events)
		.where(
			auditorEventFilter({
				address: input.address,
				fromBlock: input.fromBlock,
				toBlock: input.toBlock,
			}),
		)
		.orderBy(events.blockNumber, events.logIndex);
	const decrypted = await decryptRows(db, config, input.actor, rows);
	const aggregate = await aggregateAuditorReport(db, input.address, decrypted);

	return {
		address: input.address,
		eventCount: aggregate.eventCount,
		fromBlock: input.fromBlock?.toString() ?? null,
		inflow: aggregate.inflow,
		outflow: aggregate.outflow,
		toBlock: input.toBlock?.toString() ?? null,
	};
}

async function aggregateAuditorReport(
	db: Database,
	address: string,
	rows: AuditorEventRow[],
): Promise<{ eventCount: number; inflow: string; outflow: string }> {
	const payload = JSON.stringify(
		rows.map((row) => ({
			amount: row.amount,
			from_addr: row.fromAddr,
			to_addr: row.toAddr,
		})),
	);
	const result = await db.execute(sql`
		select
			count(*)::int as event_count,
			coalesce(
				sum(
					case
						when decrypted.to_addr = ${address} then decrypted.amount::numeric
						else 0::numeric
					end
				),
				0::numeric
			)::text as inflow,
			coalesce(
				sum(
					case
						when decrypted.from_addr = ${address} then decrypted.amount::numeric
						else 0::numeric
					end
				),
				0::numeric
			)::text as outflow
		from jsonb_to_recordset(${payload}::jsonb) as decrypted(
			amount text,
			from_addr text,
			to_addr text
		)
	`);
	const aggregate = result.rows[0] as
		| { event_count: number; inflow: string; outflow: string }
		| undefined;

	return {
		eventCount: aggregate?.event_count ?? 0,
		inflow: aggregate?.inflow ?? "0",
		outflow: aggregate?.outflow ?? "0",
	};
}

async function decryptRows(
	db: Database,
	config: ApiConfig,
	actor: string,
	rows: EventRow[],
): Promise<AuditorEventRow[]> {
	if (rows.length === 0) {
		return [];
	}

	const keys = await db
		.select()
		.from(auditorKeys)
		.orderBy(auditorKeys.activatedBlockNumber);
	const privateKeys = new Map<string, string>();
	const decryptedRows: AuditorEventRow[] = [];

	for (const row of rows) {
		if (!row.amountPct) {
			continue;
		}

		const key = findKeyForEvent(keys, row);

		if (!key) {
			throw new Error(
				`auditor_key_missing_for_event:${row.txHash}:${row.logIndex}`,
			);
		}

		let privateKey = privateKeys.get(key.id);

		if (!privateKey) {
			privateKey = unsealString(config.appMasterKey, key.sealedKey);
			privateKeys.set(key.id, privateKey);
		}

		const amount = decryptAuditorAmountPct(privateKey, row.amountPct);
		const decryptedRow = serializeAuditorEvent(row, amount, key.id);

		await db.insert(auditLog).values({
			action: "auditor_decrypt",
			actor,
			meta: {
				auditorKeyId: decryptedRow.auditorKeyId,
				blockNumber: decryptedRow.blockNumber,
				eventName: decryptedRow.eventName,
				eventRowId: decryptedRow.id,
				logIndex: decryptedRow.logIndex,
				txHash: decryptedRow.txHash,
			},
			subject: `${decryptedRow.txHash}:${decryptedRow.logIndex}`,
		});
		decryptedRows.push(decryptedRow);
	}

	return decryptedRows;
}

function findKeyForEvent(
	keys: AuditorKeyRow[],
	row: EventRow,
): AuditorKeyRow | undefined {
	return keys.find((key) => keyCoversEvent(key, row));
}

function keyCoversEvent(key: AuditorKeyRow, row: EventRow): boolean {
	return isAtOrAfterActivation(key, row) && isBeforeRetirement(key, row);
}

function isAtOrAfterActivation(key: AuditorKeyRow, row: EventRow): boolean {
	return (
		compareEventToBoundary(row, {
			blockNumber: key.activatedBlockNumber,
			logIndex: key.activatedLogIndex,
			requiresPosition: key.rotationTxHash !== null,
			transactionIndex: key.activatedTransactionIndex,
		}) >= 0
	);
}

function isBeforeRetirement(key: AuditorKeyRow, row: EventRow): boolean {
	if (key.retiredBlockNumber === null) {
		return true;
	}

	return (
		compareEventToBoundary(row, {
			blockNumber: key.retiredBlockNumber,
			logIndex: key.retiredLogIndex,
			requiresPosition: true,
			transactionIndex: key.retiredTransactionIndex,
		}) < 0
	);
}

function compareEventToBoundary(
	row: EventRow,
	boundary: {
		blockNumber: bigint;
		logIndex: number | null;
		requiresPosition: boolean;
		transactionIndex: number | null;
	},
): number {
	if (row.blockNumber < boundary.blockNumber) {
		return -1;
	}

	if (row.blockNumber > boundary.blockNumber) {
		return 1;
	}

	if (boundary.logIndex !== null) {
		return row.logIndex - boundary.logIndex;
	}

	if (boundary.transactionIndex !== null && row.transactionIndex !== null) {
		return row.transactionIndex - boundary.transactionIndex;
	}

	if (boundary.requiresPosition) {
		throw new Error(`auditor_key_ambiguous_for_event:${row.txHash}:${row.logIndex}`);
	}

	return 0;
}

function serializeAuditorEvent(
	row: EventRow,
	amount: bigint,
	auditorKeyId: string,
): AuditorEventRow {
	return {
		amount: amount.toString(),
		auditorKeyId,
		blockNumber: row.blockNumber.toString(),
		blockTime: row.blockTime.toISOString(),
		eventName: row.eventName,
		fromAddr: row.fromAddr,
		id: row.id.toString(),
		logIndex: row.logIndex,
		toAddr: row.toAddr,
		txHash: row.txHash,
	};
}

function auditorEventFilter(input: {
	address?: string;
	fromBlock?: bigint;
	toBlock?: bigint;
}): SQL {
	const addressFilter = input.address
		? (or(eq(events.fromAddr, input.address), eq(events.toAddr, input.address)) ??
			undefined)
		: undefined;

	return and(
		isNotNull(events.amountPct),
		addressFilter,
		input.fromBlock === undefined
			? undefined
			: gte(events.blockNumber, input.fromBlock),
		input.toBlock === undefined
			? undefined
			: lte(events.blockNumber, input.toBlock),
	) as SQL;
}
