import { count, desc, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { chainCursor, events } from "../db/schema.js";
import type { ChainLogSource } from "../indexer/chain.js";

type AdminRoutesOptions = {
	chain: ChainLogSource;
	config: ApiConfig;
	db: Database;
};

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.get(
		"/admin/indexer",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const [latestBlock, cursors, eventCounts] = await Promise.all([
				options.chain.getBlockNumber(),
				options.db
					.select()
					.from(chainCursor)
					.orderBy(desc(chainCursor.updatedAt)),
				options.db
					.select({
						count: count(),
						eventName: events.eventName,
					})
					.from(events)
					.groupBy(events.eventName),
			]);
			const rawConfirmedBlock =
				latestBlock - BigInt(options.config.indexerConfirmations);
			// Clamp at 0 so early-chain heights below the confirmation depth
			// don't report a negative confirmed block (matches the scanner).
			const confirmedBlock =
				rawConfirmedBlock > 0n ? rawConfirmedBlock : 0n;
			const minCursorBlock = cursors.reduce<bigint | null>(
				(minBlock, cursor) =>
					minBlock === null || cursor.lastBlock < minBlock
						? cursor.lastBlock
						: minBlock,
				null,
			);
			const lagBlocks =
				minCursorBlock === null
					? null
					: (confirmedBlock > minCursorBlock
							? confirmedBlock - minCursorBlock
							: 0n
						).toString();
			const [totalEvents] = await options.db
				.select({ count: sql<number>`count(*)::int` })
				.from(events);

			request.log.debug({ latestBlock }, "admin indexer metrics read");

			return reply.send({
				confirmedBlock: confirmedBlock.toString(),
				contracts: cursors.map((cursor) => ({
					contract: cursor.contract,
					lastBlock: cursor.lastBlock.toString(),
					lastBlockHash: cursor.lastBlockHash,
					lastPoll: cursor.updatedAt.toISOString(),
				})),
				eventCounts: Object.fromEntries(
					eventCounts.map((row) => [row.eventName, row.count]),
				),
				lagBlocks,
				lastPoll: cursors[0]?.updatedAt.toISOString() ?? null,
				latestBlock: latestBlock.toString(),
				totalEvents: totalEvents?.count ?? 0,
			});
		},
	);
};
