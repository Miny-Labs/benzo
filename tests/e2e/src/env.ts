import { describe } from "vitest";

/**
 * Master gate for the funded TIER 2 suites. Everything self-skips unless
 * `RUN_LIVE_E2E=1`, so `pnpm --filter @benzo/e2e test` is safe to run with no
 * secrets and no funds — it reports the suites as skipped, never failed. The
 * nightly `e2e-live` workflow is the only caller that sets it.
 */
export const RUN_LIVE_E2E = process.env.RUN_LIVE_E2E === "1";

/**
 * `describe` that becomes `describe.skip` unless RUN_LIVE_E2E is set. Use this
 * for every funded suite so the default run skips cleanly at collection time
 * without evaluating any on-chain hook.
 */
export const describeLive = RUN_LIVE_E2E ? describe : describe.skip;

/** Read an env var or throw a precise message naming the missing var. */
export function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(`Missing required env var ${name}`);
	}
	return value;
}

/** Read an env var with a default when unset/empty. */
export function envOr(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}
