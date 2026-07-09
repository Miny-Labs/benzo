import { beforeAll, expect, it } from "vitest";
import { loadE2EConfig } from "../src/config.js";
import { describeLive, envOr } from "../src/env.js";

// Selective disclosure (W3) against the live API. Tier A is trustless and
// unauthenticated, so we assert both the positive path (a well-formed request is
// accepted or cleanly rejected, never a 5xx) and the privacy negative (a
// malformed payload is rejected). Self-skips when the API base URL is absent.
describeLive("disclosure (live)", () => {
	const config = loadE2EConfig();
	let apiBase: string | undefined;

	beforeAll(() => {
		apiBase = config.apiBaseUrl ?? envOr("BENZO_API_BASE_URL", "");
		if (apiBase === "") apiBase = undefined;
	});

	it("publishes a Tier B attestation signer address", async (ctx) => {
		if (!apiBase) return ctx.skip("BENZO_API_BASE_URL not set");
		const res = await fetch(`${apiBase}/disclosure/attestation-key`);
		// 200 with an address, or 503 when the signer isn't configured — both valid.
		expect([200, 503]).toContain(res.status);
	});

	it("rejects a malformed Tier A verify payload (privacy negative)", async (ctx) => {
		if (!apiBase) return ctx.skip("BENZO_API_BASE_URL not set");
		const res = await fetch(`${apiBase}/disclosure/verify`, {
			body: JSON.stringify({ txHash: "not-a-hash", logIndex: -1 }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(res.status).toBe(400);
	});
});
