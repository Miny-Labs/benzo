import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
let app: FastifyInstance | undefined;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	app?.log.info({ signal }, "api shutting down");

	try {
		await app?.close();
		process.exit(0);
	} catch (error) {
		logStartupOrShutdownError(error, "api shutdown failed");
		process.exit(1);
	}
}

function logStartupOrShutdownError(error: unknown, message: string): void {
	if (app) {
		app.log.error({ err: error }, message);
		return;
	}

	console.error(message, error);
}

process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
	void shutdown("SIGINT");
});

try {
	app = await buildApp({ config });
	await app.listen({
		host: config.host,
		port: config.port,
	});
} catch (error) {
	logStartupOrShutdownError(error, "api failed to start");
	await app?.close().catch((closeError: unknown) => {
		logStartupOrShutdownError(closeError, "api startup cleanup failed");
	});
	process.exit(1);
}
