import { createPublicClient, http } from "viem";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { createViemChainLogSource } from "./chain.js";
import { runIndexerOnce } from "./scanner.js";

const fromBlock = parseFromBlock(process.argv);
const config = loadConfig();
const pool = createPool(config);
const db = createDb(pool);
const publicClient = createPublicClient({
	transport: http(config.benzonetRpcUrl),
});

try {
	const result = await runIndexerOnce({
		chain: createViemChainLogSource(publicClient),
		config,
		db,
		fromBlock,
	});

	console.log(JSON.stringify(result, null, 2));
} finally {
	await pool.end();
}

function parseFromBlock(argv: string[]): bigint {
	const flagIndex = argv.indexOf("--from-block");
	const rawValue = flagIndex === -1 ? undefined : argv[flagIndex + 1];

	if (!rawValue || !/^\d+$/.test(rawValue)) {
		throw new Error("Usage: pnpm --filter @benzo/api index:backfill --from-block <n>");
	}

	return BigInt(rawValue);
}
