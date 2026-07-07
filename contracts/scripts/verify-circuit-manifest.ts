import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..");

const result = spawnSync("pnpm", ["--filter", "@benzo/config", "test"], {
	cwd: repoRoot,
	env: {
		...process.env,
		STRICT_CIRCUIT_MANIFEST: "1",
	},
	stdio: "inherit",
});

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
