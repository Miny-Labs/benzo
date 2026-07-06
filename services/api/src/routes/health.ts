import { sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { PublicClient } from "viem";
import type { Database } from "../db/client.js";

type HealthRoutesOptions = {
	db: Database;
	publicClient: PublicClient;
};

type CheckResult =
	| {
			latencyMs: number;
			ok: true;
	  }
	| {
			error: string;
			latencyMs: number;
			ok: false;
	  };

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.get("/healthz", async (request, reply) => {
		const [db, rpc] = await Promise.all([
			checkDb(options.db, request.log),
			checkRpc(options.publicClient, request.log),
		]);
		const ok = db.ok && rpc.ok;

		return reply.code(ok ? 200 : 503).send({
			db,
			rpc,
			status: ok ? "ok" : "degraded",
		});
	});
};

async function checkDb(
	db: Database,
	logger: FastifyBaseLogger,
): Promise<CheckResult> {
	const startedAt = Date.now();

	try {
		await db.execute(sql`select 1`);
		return {
			latencyMs: Date.now() - startedAt,
			ok: true,
		};
	} catch (error) {
		logger.error({ err: error }, "database health check failed");

		return {
			error: "db_unreachable",
			latencyMs: Date.now() - startedAt,
			ok: false,
		};
	}
}

async function checkRpc(
	publicClient: PublicClient,
	logger: FastifyBaseLogger,
): Promise<CheckResult & { blockNumber?: string }> {
	const startedAt = Date.now();

	try {
		const blockNumber = await publicClient.getBlockNumber();
		return {
			blockNumber: blockNumber.toString(),
			latencyMs: Date.now() - startedAt,
			ok: true,
		};
	} catch (error) {
		logger.error({ err: error }, "rpc health check failed");

		return {
			error: "rpc_unreachable",
			latencyMs: Date.now() - startedAt,
			ok: false,
		};
	}
}
