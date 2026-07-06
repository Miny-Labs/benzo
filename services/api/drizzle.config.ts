import { defineConfig } from "drizzle-kit";
import { loadConfig } from "./src/config.js";

const config = loadConfig();

export default defineConfig({
	dialect: "postgresql",
	dbCredentials: {
		url: config.databaseUrl,
	},
	out: "./drizzle",
	schema: "./src/db/schema.ts",
	strict: true,
	verbose: true,
});
