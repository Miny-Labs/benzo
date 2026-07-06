import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
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
	fastify.get("/healthz", async (_request, reply) => {
		const [db, rpc] = await Promise.all([
			checkDb(options.db),
			checkRpc(options.publicClient),
		]);
		const ok = db.ok && rpc.ok;

		return reply.code(ok ? 200 : 503).send({
			db,
			rpc,
			status: ok ? "ok" : "degraded",
		});
	});
};

async function checkDb(db: Database): Promise<CheckResult> {
	const startedAt = Date.now();

	try {
		await db.execute(sql`select 1`);
		return {
			latencyMs: Date.now() - startedAt,
			ok: true,
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : "unknown_error",
			latencyMs: Date.now() - startedAt,
			ok: false,
		};
	}
}

async function checkRpc(
	publicClient: PublicClient,
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
		return {
			error: error instanceof Error ? error.message : "unknown_error",
			latencyMs: Date.now() - startedAt,
			ok: false,
		};
	}
}
