import {
	and,
	desc,
	eq,
	gte,
	isNotNull,
	lte,
	or,
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
		.orderBy(events.blockNumber, events.logIndex)
		.limit(5_000);
	const decrypted = await decryptRows(db, config, input.actor, rows);
	let inflow = 0n;
	let outflow = 0n;

	for (const row of decrypted) {
		const amount = BigInt(row.amount);

		if (row.toAddr === input.address) {
			inflow += amount;
		}

		if (row.fromAddr === input.address) {
			outflow += amount;
		}
	}

	return {
		address: input.address,
		eventCount: decrypted.length,
		fromBlock: input.fromBlock?.toString() ?? null,
		inflow: inflow.toString(),
		outflow: outflow.toString(),
		toBlock: input.toBlock?.toString() ?? null,
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
		decryptedRows.push(serializeAuditorEvent(row, amount, key.id));
	}

	await db.insert(auditLog).values(
		decryptedRows.map((row) => ({
			action: "auditor_decrypt",
			actor,
			meta: {
				auditorKeyId: row.auditorKeyId,
				blockNumber: row.blockNumber,
				eventName: row.eventName,
				eventRowId: row.id,
				logIndex: row.logIndex,
				txHash: row.txHash,
			},
			subject: `${row.txHash}:${row.logIndex}`,
		})),
	);

	return decryptedRows;
}

function findKeyForEvent(
	keys: AuditorKeyRow[],
	row: EventRow,
): AuditorKeyRow | undefined {
	return keys.find(
		(key) =>
			key.activatedBlockNumber <= row.blockNumber &&
			(key.retiredBlockNumber === null ||
				row.blockNumber < key.retiredBlockNumber),
	);
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
