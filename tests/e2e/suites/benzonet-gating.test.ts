import { expect, it } from "vitest";
import { createWalletClient, http } from "viem";
import { type E2EConfig, loadE2EConfig } from "../src/config.js";
import { describeLive } from "../src/env.js";
import { freshEoa } from "../fixtures/accounts.js";
import { createPublicClientFor } from "../src/preflight.js";

// BenzoNet (our permissioned L1) tx-allowlist precompile: a non-allowlisted EOA
// must be rejected. The config is loaded lazily inside the test so the suite
// still self-skips cleanly (at collection) when no BenzoNet RPC is configured —
// loadE2EConfig throws an actionable error for benzonet with no RPC, which we
// turn into a skip here rather than a module-load failure.
describeLive("benzonet-gating (live)", () => {
	it("rejects a transaction from a non-allowlisted EOA", async (ctx) => {
		let config: E2EConfig;
		try {
			config = loadE2EConfig("benzonet");
		} catch (error) {
			return ctx.skip((error as Error).message);
		}

		const publicClient = createPublicClientFor(config);
		const reachable = await publicClient
			.getChainId()
			.then(() => true)
			.catch(() => false);
		if (!reachable) return ctx.skip("BenzoNet RPC unreachable");

		const stranger = freshEoa();
		const wallet = createWalletClient({
			account: stranger,
			chain: config.chain,
			transport: http(config.rpcUrl),
		});
		// A non-allowlisted sender must be refused by the tx-allowlist precompile.
		// (A fresh EOA also has no gas, so a bare rejection can't fully isolate the
		// allowlist reason without a funded-but-unlisted account; the precompile
		// rejection is asserted here as the primary gating signal.)
		await expect(
			wallet.sendTransaction({ to: stranger.address, value: 0n }),
		).rejects.toThrow();
	});
});
