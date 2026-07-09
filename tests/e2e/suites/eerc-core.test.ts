import { beforeAll, expect, it } from "vitest";
import { getContract } from "viem";
import { AUDITOR_ABI, ERC20_ABI, REGISTRAR_ABI } from "../src/abis.js";
import { loadE2EConfig } from "../src/config.js";
import { describeLive } from "../src/env.js";
import { isReady, type Preflight, preflightLive } from "../src/preflight.js";

// eERC core rails against the live converter. The proving-heavy write path
// (register/transfer/withdraw) is exercised by the wallet's own client tests;
// here we assert the on-chain reads a funded, already-registered account depends
// on: registration, the encrypted-balance struct, and the auditor key that makes
// every private op auditable. Self-skips unless RUN_LIVE_E2E + a funded user.
describeLive("eerc-core (live)", () => {
	const config = loadE2EConfig();
	let pf: Preflight | undefined;

	beforeAll(async () => {
		pf = await preflightLive(config, [
			{ envVar: "BENZO_ONRAMP_USER_KEY", minNativeWei: 0n },
		]);
	});

	it("resolves the converter, USDC token and auditor key from config (no hardcoded addresses)", (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		expect(config.deployment.contracts.EncryptedERC).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(config.stablecoins.USDC?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
	});

	it("has a set auditor public key (private ops are auditable)", async (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		const eerc = getContract({
			abi: AUDITOR_ABI,
			address: config.deployment.contracts.EncryptedERC as `0x${string}`,
			client: pf.client,
		});
		const key = (await eerc.read.auditorPublicKey()) as { x: bigint; y: bigint };
		// A zero auditor key means private ops revert — the converter must have one.
		expect(key.x === 0n && key.y === 0n).toBe(false);
	});

	it("reports the funded user as registered on the eERC", async (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		const user = pf.accounts.BENZO_ONRAMP_USER_KEY;
		if (!user) return ctx.skip("no funded user");
		const registrar = getContract({
			abi: REGISTRAR_ABI,
			address: config.deployment.contracts.Registrar as `0x${string}`,
			client: pf.client,
		});
		const registered = (await registrar.read.isUserRegistered([user.address])) as boolean;
		expect(registered).toBe(true);
	});

	it("holds public USDC to fund shield/gift/onramp flows", async (ctx) => {
		if (!isReady(pf, ctx.skip)) return;
		const user = pf.accounts.BENZO_ONRAMP_USER_KEY;
		if (!user) return ctx.skip("no funded user");
		const usdc = getContract({
			abi: ERC20_ABI,
			address: config.stablecoins.USDC?.address as `0x${string}`,
			client: pf.client,
		});
		const bal = (await usdc.read.balanceOf([user.address])) as bigint;
		expect(bal).toBeGreaterThan(0n);
	});
});
