import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { ApiConfig } from "../config.js";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

type PoolLogger = {
	error: (bindings: { err: unknown }, message: string) => void;
};

export function createPool(config: ApiConfig, logger?: PoolLogger): Pool {
	const pool = new Pool({
		connectionString: config.databaseUrl,
		max: 10,
	});

	pool.on("error", (error) => {
		if (logger) {
			logger.error({ err: error }, "postgres idle client error");
			return;
		}

		console.error("postgres idle client error", error);
	});

	return pool;
}

export function createDb(pool: Pool): Database {
	return drizzle(pool, { schema });
}
