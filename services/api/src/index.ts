import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

try {
	await app.listen({
		host: config.host,
		port: config.port,
	});
} catch (error) {
	app.log.error({ err: error }, "api failed to start");
	process.exit(1);
}
