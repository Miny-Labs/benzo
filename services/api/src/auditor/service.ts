import { createHash } from "node:crypto";
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
import {
	decryptAuditorAmountPct,
	signAuditorManifestHash,
	type AuditorManifestSignature,
} from "./crypto.js";

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

export type AuditorPacketKey = {
	active: boolean;
	activatedBlockNumber: string;
	activatedLogIndex: number | null;
	activatedTransactionIndex: number | null;
	id: string;
	publicKey: [string, string];
	retiredBlockNumber: string | null;
	retiredLogIndex: number | null;
	retiredTransactionIndex: number | null;
	rotationTxHash: string | null;
};

export type AuditorPacket = {
	address: string;
	auditorKeys: AuditorPacketKey[];
	fromBlock: string | null;
	generatedAt: string;
	inflow: string;
	manifestHash: string;
	outflow: string;
	rows: AuditorEventRow[];
	signature: AuditorManifestSignature & { signerKeyId: string };
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

type ExportAuditorReportCsvInput = BuildAuditorReportInput;
type BuildAuditorPacketInput = BuildAuditorReportInput;

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
	const dataset = await buildAuditorReportDataset(db, config, input);

	return dataset.report;
}

export async function exportAuditorReportCsv(
	db: Database,
	config: ApiConfig,
	input: ExportAuditorReportCsvInput,
): Promise<{ csv: string; report: AuditorReport }> {
	const dataset = await buildAuditorReportDataset(db, config, input);

	await db.insert(auditLog).values({
		action: "auditor_report_csv_export",
		actor: input.actor,
		meta: {
			address: input.address,
			eventCount: dataset.report.eventCount,
			fromBlock: dataset.report.fromBlock,
			inflow: dataset.report.inflow,
			outflow: dataset.report.outflow,
			toBlock: dataset.report.toBlock,
		},
		subject: input.address,
	});

	return {
		csv: serializeAuditorReportCsv(dataset.rows),
		report: dataset.report,
	};
}

export async function buildAuditorPacket(
	db: Database,
	config: ApiConfig,
	input: BuildAuditorPacketInput,
): Promise<AuditorPacket> {
	const dataset = await buildAuditorReportDataset(db, config, input);
	const keys = await loadAuditorKeys(db);
	const packetKeys = keys
		.filter(
			(key) =>
				key.active ||
				auditorKeyRangeIntersects(
					key,
					input.fromBlock ?? null,
					input.toBlock ?? null,
				),
		)
		.map(serializeAuditorPacketKey);
	const signerKey = selectAuditorPacketSigner(keys);

	if (!signerKey) {
		throw new Error("auditor_key_missing_for_packet_signer");
	}

	const signerPrivateKey = unsealString(config.appMasterKey, signerKey.sealedKey);
	const manifestHash = hashAuditorPacketRows(dataset.rows);
	const signature = {
		...signAuditorManifestHash(signerPrivateKey, manifestHash),
		signerKeyId: signerKey.id,
	};
	const packet: AuditorPacket = {
		address: input.address,
		auditorKeys: packetKeys,
		fromBlock: dataset.report.fromBlock,
		generatedAt: new Date().toISOString(),
		inflow: dataset.report.inflow,
		manifestHash,
		outflow: dataset.report.outflow,
		rows: dataset.rows,
		signature,
		toBlock: dataset.report.toBlock,
	};

	await db.insert(auditLog).values({
		action: "auditor_packet_export",
		actor: input.actor,
		meta: {
			address: packet.address,
			auditorKeyIds: packet.auditorKeys.map((key) => key.id),
			eventCount: packet.rows.length,
			fromBlock: packet.fromBlock,
			inflow: packet.inflow,
			manifestHash: packet.manifestHash,
			outflow: packet.outflow,
			signerKeyId: packet.signature.signerKeyId,
			toBlock: packet.toBlock,
		},
		subject: input.address,
	});

	return packet;
}

export function hashAuditorPacketRows(rows: AuditorEventRow[]): string {
	return `0x${createHash("sha256")
		.update(canonicalizeAuditorPacketRows(rows))
		.digest("hex")}`;
}

async function buildAuditorReportDataset(
	db: Database,
	config: ApiConfig,
	input: BuildAuditorReportInput,
): Promise<{ report: AuditorReport; rows: AuditorEventRow[] }> {
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
		report: {
			address: input.address,
			eventCount: aggregate.eventCount,
			fromBlock: input.fromBlock?.toString() ?? null,
			inflow: aggregate.inflow,
			outflow: aggregate.outflow,
			toBlock: input.toBlock?.toString() ?? null,
		},
		rows: decrypted,
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

	const keys = await loadAuditorKeys(db);
	const privateKeys = new Map<string, string>();
	const decryptedRows: AuditorEventRow[] = [];
	const auditRows: (typeof auditLog.$inferInsert)[] = [];

	// Flush accumulated audit-log rows in chunks (auditLog has ~5 columns, well
	// under Postgres's 65,535 bind-param limit at 1,000 rows). Run this in a
	// `finally` so events decrypted before a mid-loop failure are still logged —
	// the invariant is "every decrypt is audit-logged" — without doing one
	// INSERT round-trip per event (which timed out on large reports).
	const flushAuditRows = async () => {
		const AUDIT_BATCH = 1_000;
		for (let index = 0; index < auditRows.length; index += AUDIT_BATCH) {
			await db.insert(auditLog).values(auditRows.slice(index, index + AUDIT_BATCH));
		}
		auditRows.length = 0;
	};

	try {
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

			auditRows.push({
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
	} finally {
		await flushAuditRows();
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

async function loadAuditorKeys(db: Database): Promise<AuditorKeyRow[]> {
	return db
		.select()
		.from(auditorKeys)
		.orderBy(auditorKeys.activatedBlockNumber, auditorKeys.activatedLogIndex);
}

function selectAuditorPacketSigner(
	keys: AuditorKeyRow[],
): AuditorKeyRow | undefined {
	return keys
		.filter((key) => key.active)
		.sort(compareAuditorKeysByActivation)
		.at(-1);
}

function compareAuditorKeysByActivation(
	left: AuditorKeyRow,
	right: AuditorKeyRow,
): number {
	const blockDiff = compareBigint(
		left.activatedBlockNumber,
		right.activatedBlockNumber,
	);

	if (blockDiff !== 0) {
		return blockDiff;
	}

	return (
		(left.activatedLogIndex ?? -1) - (right.activatedLogIndex ?? -1) ||
		(left.activatedTransactionIndex ?? -1) -
			(right.activatedTransactionIndex ?? -1)
	);
}

function compareBigint(left: bigint, right: bigint): number {
	if (left < right) {
		return -1;
	}

	if (left > right) {
		return 1;
	}

	return 0;
}

function auditorKeyRangeIntersects(
	key: AuditorKeyRow,
	fromBlock: bigint | null,
	toBlock: bigint | null,
): boolean {
	if (toBlock !== null && key.activatedBlockNumber > toBlock) {
		return false;
	}

	if (fromBlock !== null && key.retiredBlockNumber !== null) {
		return key.retiredBlockNumber >= fromBlock;
	}

	return true;
}

function serializeAuditorPacketKey(key: AuditorKeyRow): AuditorPacketKey {
	return {
		active: key.active,
		activatedBlockNumber: key.activatedBlockNumber.toString(),
		activatedLogIndex: key.activatedLogIndex,
		activatedTransactionIndex: key.activatedTransactionIndex,
		id: key.id,
		publicKey: [key.publicKeyX, key.publicKeyY],
		retiredBlockNumber: key.retiredBlockNumber?.toString() ?? null,
		retiredLogIndex: key.retiredLogIndex,
		retiredTransactionIndex: key.retiredTransactionIndex,
		rotationTxHash: key.rotationTxHash,
	};
}

function serializeAuditorReportCsv(rows: AuditorEventRow[]): string {
	const fields = [
		"id",
		"txHash",
		"logIndex",
		"blockNumber",
		"blockTime",
		"eventName",
		"fromAddr",
		"toAddr",
		"amount",
		"auditorKeyId",
	] as const;
	const lines = [
		fields.join(","),
		...rows.map((row) =>
			fields.map((field) => csvCell(row[field])).join(","),
		),
	];

	return `${lines.join("\n")}\n`;
}

function csvCell(value: number | string | null): string {
	const text = value === null ? "" : value.toString();

	if (!/[",\n\r]/.test(text)) {
		return text;
	}

	return `"${text.replaceAll("\"", "\"\"")}"`;
}

function canonicalizeAuditorPacketRows(rows: AuditorEventRow[]): string {
	return JSON.stringify(rows.map(canonicalizeAuditorPacketRow));
}

function canonicalizeAuditorPacketRow(row: AuditorEventRow): AuditorEventRow {
	return {
		amount: row.amount,
		auditorKeyId: row.auditorKeyId,
		blockNumber: row.blockNumber,
		blockTime: row.blockTime,
		eventName: row.eventName,
		fromAddr: row.fromAddr,
		id: row.id,
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
