import { expect, it } from "vitest";
import { createWalletClient, http } from "viem";
import { loadE2EConfig } from "../src/config.js";
import { describeLive } from "../src/env.js";
import { freshEoa } from "../fixtures/accounts.js";
import { createPublicClientFor } from "../src/preflight.js";

// BenzoNet (our permissioned L1) tx-allowlist precompile: a non-allowlisted EOA
// must be rejected. We only run when the target is benzonet and the RPC is
// reachable; a fresh (never-allowlisted) EOA attempting a tx must be refused.
describeLive("benzonet-gating (live)", () => {
	const config = loadE2EConfig("benzonet");

	it("rejects a transaction from a non-allowlisted EOA", async (ctx) => {
		const publicClient = createPublicClientFor(config);
		// Confirm the RPC is up; otherwise skip rather than fail.
		const reachable = await publicClient.getChainId().then(() => true).catch(() => false);
		if (!reachable) return ctx.skip("BenzoNet RPC unreachable");

		const stranger = freshEoa();
		const wallet = createWalletClient({
			account: stranger,
			chain: config.chain,
			transport: http(config.rpcUrl),
		});
		// A non-allowlisted sender must be refused by the tx-allowlist precompile.
		await expect(
			wallet.sendTransaction({ to: stranger.address, value: 0n }),
		).rejects.toThrow();
	});
});
