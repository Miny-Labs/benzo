import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "./client.js";

export async function runMigrations(): Promise<void> {
	const config = loadConfig();
	const pool = createPool(config);
	const db = createDb(pool);
	const migrationsFolder = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../drizzle",
	);

	try {
		await migrate(db, { migrationsFolder });
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runMigrations();
}
