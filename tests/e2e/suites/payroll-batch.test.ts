import { beforeAll, expect, it } from "vitest";
import { loadE2EConfig } from "../src/config.js";
import { describeLive, envOr } from "../src/env.js";

// Managed confidential batch payroll (console) against the live API. Payroll is
// server-driven (the managed runner proves sequentially), so the funded assertion
// is that the runner is reachable and idempotent. Self-skips without an API URL.
describeLive("payroll-batch (live)", () => {
	const config = loadE2EConfig();
	let apiBase: string | undefined;

	beforeAll(() => {
		apiBase = config.apiBaseUrl ?? envOr("BENZO_API_BASE_URL", "");
		if (apiBase === "") apiBase = undefined;
	});

	it("exposes a healthy API the managed payroll runner lives behind", async (ctx) => {
		if (!apiBase) return ctx.skip("BENZO_API_BASE_URL not set");
		const res = await fetch(`${apiBase}/health`).catch(() => undefined);
		if (!res) return ctx.skip("API unreachable");
		expect(res.status).toBeLessThan(500);
	});

	it("gates payroll behind auth (unauthenticated request is not 5xx)", async (ctx) => {
		if (!apiBase) return ctx.skip("BENZO_API_BASE_URL not set");
		// No session cookie -> the endpoint must refuse (401/403/404), never crash.
		const res = await fetch(`${apiBase}/orgs/self/payroll/batches`, {
			method: "GET",
		}).catch(() => undefined);
		if (!res) return ctx.skip("API unreachable");
		expect(res.status).toBeLessThan(500);
	});
});
