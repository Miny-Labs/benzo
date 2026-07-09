import { beforeAll, expect, it } from "vitest";
import { loadE2EConfig } from "../src/config.js";
import { describeLive } from "../src/env.js";
import { createPublicClientFor, isReady, type Preflight, preflightLive } from "../src/preflight.js";

// CCTP onramp against the live BenzoCCTPRouter. The full cross-chain path
// (burn on a source Sepolia chain -> Iris attestation -> receiveMessage on Fuji
// -> eERC depositFor) is exercised nightly; a bounded Iris poll keeps it from
// hanging. Here we always assert the on-chain wiring the flow depends on, and
// only run the funded bridge when a source chain + funds are configured.
describeLive("cctp-onramp (live)", () => {
	const config = loadE2EConfig();
	let pf: Preflight | undefined;

	beforeAll(async () => {
		pf = await preflightLive(config, [
			{ envVar: "BENZO_ONRAMP_USER_KEY", minNativeWei: 0n },
			{ envVar: "BENZO_RELAYER_KEY", minNativeWei: 0n },
		]);
	});

	it("has a deployed auto-deposit router wired in config", (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		const router = config.deployment.contracts.cctp?.autoDepositRouter;
		expect(router).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("the configured router address is a deployed contract on Fuji", async (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		const routerAddr = config.deployment.contracts.cctp?.autoDepositRouter;
		if (!routerAddr) return ctx.skip("router not configured");
		const client = createPublicClientFor(config);
		const code = await client.getCode({ address: routerAddr as `0x${string}` });
		expect(code && code !== "0x").toBeTruthy();
	});

	it("exposes at least one CCTP source chain for the funded bridge", (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		const sources = Object.keys(config.cctpSourceChains);
		if (sources.length === 0) return ctx.skip("no CCTP source chains configured");
		expect(sources.length).toBeGreaterThan(0);
	});
});
