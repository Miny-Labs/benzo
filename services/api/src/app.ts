import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, {
	type FastifyBaseLogger,
	type FastifyServerOptions,
} from "fastify";
import { createPublicClient, http } from "viem";
import { loadConfig, type ApiConfig } from "./config.js";
import { createDb, createPool, type Database } from "./db/client.js";
import { createBoss, registerJobs } from "./jobs/index.js";
import authPlugin from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";

export type BuildAppOptions = {
	boss?: PgBoss;
	config?: ApiConfig;
	db?: Database;
	logger?: FastifyServerOptions["logger"];
	pool?: Pool;
	startBoss?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}) {
	const config = options.config ?? loadConfig();
	const pool = options.pool ?? createPool(config);
	const db = options.db ?? createDb(pool);
	const boss = options.boss ?? createBoss(config);
	const ownsBoss = !options.boss;
	const ownsPool = !options.pool;
	const publicClient = createPublicClient({
		transport: http(config.benzonetRpcUrl),
	});

	const fastify = Fastify({
		genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID(),
		logger: options.logger ?? {
			level: config.logLevel,
		},
	});

	fastify.addHook("onRequest", async (request, reply) => {
		reply.header("x-request-id", request.id);
	});

	fastify.setErrorHandler(async (error, request, reply) => {
		request.log.error({ err: error }, "request failed");
		await reply.code(500).send({ error: "internal_server_error" });
	});

	await fastify.register(cookie);
	await fastify.register(authPlugin, { config, db });
	await fastify.register(healthRoutes, { db, publicClient });
	await fastify.register(authRoutes, { config, db, publicClient });

	if (options.startBoss !== false) {
		await boss.start();
		await registerJobs(boss, db, fastify.log as FastifyBaseLogger);
	}

	fastify.addHook("onClose", async () => {
		if (options.startBoss !== false && ownsBoss) {
			await boss.stop();
		}

		if (ownsPool) {
			await pool.end();
		}
	});

	return fastify;
}
