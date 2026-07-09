import { defineConfig } from "vitest/config";

// Funded live-testnet suites. They self-skip cleanly when RUN_LIVE_E2E is unset
// (see src/env.ts), so a plain `vitest run` is safe and needs no funds; the
// nightly workflow sets RUN_LIVE_E2E=1 to actually exercise them.
export default defineConfig({
	test: {
		environment: "node",
		include: ["suites/**/*.test.ts"],
		// Live CCTP finality + on-chain proving are slow; keep generous ceilings.
		testTimeout: 600_000,
		hookTimeout: 600_000,
		// One relayer nonce stream — never run funded suites in parallel.
		fileParallelism: false,
		sequence: { concurrent: false },
	},
});
