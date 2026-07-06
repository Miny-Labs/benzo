import {
	and,
	desc,
	eq,
	gt,
	inArray,
	lt,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { eventLinks, events } from "../db/schema.js";

type ActivityRoutesOptions = {
	db: Database;
};

const activityQuerySchema = z.object({
	address: z.string().optional(),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

const receiptParamsSchema = z.object({
	txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export const activityRoutes: FastifyPluginAsync<ActivityRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.get(
		"/activity",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const query = activityQuerySchema.safeParse(request.query);

			if (!query.success) {
				return reply.code(400).send({ error: "invalid_activity_query" });
			}

			const address = authorizeRequestedAddress(
				request.user?.address,
				query.data.address,
			);

			if (!address) {
				return reply.code(403).send({ error: "forbidden" });
			}

			const cursor = parseCursor(query.data.cursor);

			if (query.data.cursor && !cursor) {
				return reply.code(400).send({ error: "invalid_cursor" });
			}

			const rows = await loadActivityRows(options.db, {
				address,
				cursor,
				limit: query.data.limit + 1,
			});
			const visibleRows = rows.slice(0, query.data.limit);
			const linksByTxHash = await loadLinksByTxHash(
				options.db,
				visibleRows.map((row) => row.txHash),
			);
			const nextRow =
				rows.length > query.data.limit
					? visibleRows[visibleRows.length - 1]
					: undefined;

			return reply.send({
				activity: visibleRows.map((row) =>
					serializeEvent(row, linksByTxHash.get(row.txHash) ?? []),
				),
				nextCursor: nextRow ? formatCursor(nextRow) : null,
			});
		},
	);

	fastify.get(
		"/receipts/:txHash",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const params = receiptParamsSchema.safeParse(request.params);

			if (!params.success || !request.user) {
				return reply.code(400).send({ error: "invalid_receipt_query" });
			}

			const txHash = params.data.txHash.toLowerCase();
			const rows = await options.db
				.select()
				.from(events)
				.where(
					and(
						eq(events.txHash, txHash),
						participantFilter(request.user.address),
					),
				)
				.orderBy(events.logIndex);

			if (rows.length === 0) {
				return reply.code(404).send({ error: "receipt_not_found" });
			}

			const links = await loadLinksByTxHash(options.db, [txHash]);

			return reply.send({
				events: rows.map((row) =>
					serializeEvent(row, links.get(row.txHash) ?? []),
				),
				links: links.get(txHash) ?? [],
				txHash,
			});
		},
	);

	fastify.get(
		"/activity/stream",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const query = activityQuerySchema.safeParse(request.query);

			if (!query.success) {
				return reply.code(400).send({ error: "invalid_activity_query" });
			}

			const address = authorizeRequestedAddress(
				request.user?.address,
				query.data.address,
			);

			if (!address) {
				return reply.code(403).send({ error: "forbidden" });
			}

			const parsedCursor = parseCursor(query.data.cursor);

			if (query.data.cursor && !parsedCursor) {
				return reply.code(400).send({ error: "invalid_cursor" });
			}

			let cursor =
				parsedCursor ??
				(await loadLatestActivityCursor(options.db, address));

			reply.hijack();
			reply.raw.writeHead(200, {
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"content-type": "text/event-stream",
				"x-accel-buffering": "no",
			});
			reply.raw.write(": connected\n\n");

			const sendNewRows = async () => {
				const rows = await loadNewActivityRows(options.db, {
					address,
					cursor,
					limit: query.data.limit,
				});

				if (rows.length === 0) {
					reply.raw.write(": heartbeat\n\n");
					return;
				}

				const linksByTxHash = await loadLinksByTxHash(
					options.db,
					rows.map((row) => row.txHash),
				);

				for (const row of rows) {
					cursor = {
						blockNumber: row.blockNumber,
						logIndex: row.logIndex,
					};
					reply.raw.write(
						`event: activity\ndata: ${JSON.stringify(
							serializeEvent(row, linksByTxHash.get(row.txHash) ?? []),
						)}\n\n`,
					);
				}
			};
			// Serialize polls: a slow DB query must not let the interval start a
			// second sendNewRows() that races the mutable `cursor`. If a poll is
			// still in flight when the timer fires, skip that tick.
			let polling = false;
			const runPoll = () => {
				if (polling) {
					return;
				}
				polling = true;
				void sendNewRows()
					.catch((error: unknown) => {
						request.log.error({ err: error }, "activity stream poll failed");
					})
					.finally(() => {
						polling = false;
					});
			};

			const interval = setInterval(runPoll, 5_000);

			request.raw.on("close", () => {
				clearInterval(interval);
			});

			runPoll();
		},
	);
};

type Cursor = {
	blockNumber: bigint;
	logIndex: number;
};

type EventRow = typeof events.$inferSelect;

type LinkRow = Pick<
	typeof eventLinks.$inferSelect,
	"label" | "objectId" | "objectType" | "txHash"
>;

async function loadActivityRows(
	db: Database,
	input: {
		address: string;
		cursor?: Cursor;
		limit: number;
	},
): Promise<EventRow[]> {
	return db
		.select()
		.from(events)
		.where(
			and(
				participantFilter(input.address),
				input.cursor ? beforeCursorFilter(input.cursor) : undefined,
			),
		)
		.orderBy(desc(events.blockNumber), desc(events.logIndex))
		.limit(input.limit);
}

async function loadNewActivityRows(
	db: Database,
	input: {
		address: string;
		cursor?: Cursor;
		limit: number;
	},
): Promise<EventRow[]> {
	return db
		.select()
		.from(events)
		.where(
			and(
				participantFilter(input.address),
				input.cursor ? afterCursorFilter(input.cursor) : undefined,
			),
		)
		.orderBy(events.blockNumber, events.logIndex)
		.limit(input.limit);
}

async function loadLatestActivityCursor(
	db: Database,
	address: string,
): Promise<Cursor | undefined> {
	const [row] = await db
		.select({
			blockNumber: events.blockNumber,
			logIndex: events.logIndex,
		})
		.from(events)
		.where(participantFilter(address))
		.orderBy(desc(events.blockNumber), desc(events.logIndex))
		.limit(1);

	return row;
}

async function loadLinksByTxHash(
	db: Database,
	txHashes: string[],
): Promise<Map<string, LinkRow[]>> {
	const uniqueTxHashes = [...new Set(txHashes)];

	if (uniqueTxHashes.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			label: eventLinks.label,
			objectId: eventLinks.objectId,
			objectType: eventLinks.objectType,
			txHash: eventLinks.txHash,
		})
		.from(eventLinks)
		.where(inArray(eventLinks.txHash, uniqueTxHashes));
	const byTxHash = new Map<string, LinkRow[]>();

	for (const row of rows) {
		const links = byTxHash.get(row.txHash) ?? [];
		links.push(row);
		byTxHash.set(row.txHash, links);
	}

	return byTxHash;
}

function participantFilter(address: string): SQL {
	return or(eq(events.fromAddr, address), eq(events.toAddr, address)) ?? sql`false`;
}

function beforeCursorFilter(cursor: Cursor): SQL {
	return (
		or(
			lt(events.blockNumber, cursor.blockNumber),
			and(
				eq(events.blockNumber, cursor.blockNumber),
				lt(events.logIndex, cursor.logIndex),
			),
		) ?? sql`false`
	);
}

function afterCursorFilter(cursor: Cursor): SQL {
	return (
		or(
			gt(events.blockNumber, cursor.blockNumber),
			and(
				eq(events.blockNumber, cursor.blockNumber),
				gt(events.logIndex, cursor.logIndex),
			),
		) ?? sql`false`
	);
}

function authorizeRequestedAddress(
	authenticatedAddress: string | undefined,
	requestedAddress: string | undefined,
): string | null {
	if (!authenticatedAddress) {
		return null;
	}

	if (!requestedAddress) {
		return authenticatedAddress;
	}

	if (!isAddress(requestedAddress, { strict: false })) {
		return null;
	}

	const normalized = getAddress(requestedAddress).toLowerCase();
	return normalized === authenticatedAddress ? normalized : null;
}

function parseCursor(cursor: string | undefined): Cursor | undefined {
	if (!cursor) {
		return undefined;
	}

	const [blockNumber, logIndex] = cursor.split(":");

	if (
		!blockNumber ||
		!logIndex ||
		!/^\d+$/.test(blockNumber) ||
		!/^\d+$/.test(logIndex)
	) {
		return undefined;
	}

	const parsedLogIndex = Number(logIndex);

	if (!Number.isInteger(parsedLogIndex) || parsedLogIndex < 0) {
		return undefined;
	}

	return {
		blockNumber: BigInt(blockNumber),
		logIndex: parsedLogIndex,
	};
}

function formatCursor(row: Pick<EventRow, "blockNumber" | "logIndex">): string {
	return `${row.blockNumber.toString()}:${row.logIndex}`;
}

function serializeEvent(row: EventRow, links: LinkRow[]): Record<string, unknown> {
	return {
		amountPct: bufferToHex(row.amountPct),
		blockNumber: row.blockNumber.toString(),
		blockTime: row.blockTime.toISOString(),
		ciphertext: row.ciphertext.map((value) => bufferToHex(value)),
		contract: row.contract,
		eventName: row.eventName,
		fromAddr: row.fromAddr,
		links,
		logIndex: row.logIndex,
		rawLog: row.rawLog,
		toAddr: row.toAddr,
		txHash: row.txHash,
	};
}

function bufferToHex(value: Buffer | null): string | null {
	if (!value) {
		return null;
	}

	return `0x${value.toString("hex")}`;
}
