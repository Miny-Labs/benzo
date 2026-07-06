import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { ApiConfig } from "../config.js";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export function createPool(config: ApiConfig): Pool {
	return new Pool({
		connectionString: config.databaseUrl,
		max: 10,
	});
}

export function createDb(pool: Pool): Database {
	return drizzle(pool, { schema });
}
