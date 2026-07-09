import { beforeAll, expect, it } from "vitest";
import { getContract } from "viem";
import { AUDITOR_ABI } from "../src/abis.js";
import { loadE2EConfig } from "../src/config.js";
import { describeLive } from "../src/env.js";
import { createPublicClientFor } from "../src/preflight.js";

// Auditor custody / rotation invariant. Rotating the auditor key is an owner-only
// server op; the safety invariant a rotation must preserve is that the converter
// always has a non-zero auditor public key (a zero key makes every private op
// revert). We assert that invariant on-chain; the funded rotation itself is a
// managed, owner-gated backend action exercised nightly.
describeLive("auditor-rotate (live)", () => {
	const config = loadE2EConfig();

	beforeAll(() => {});

	it("keeps a non-zero auditor public key on the live converter", async (ctx) => {
		const eercAddr = config.deployment.contracts.EncryptedERC;
		if (!eercAddr) return ctx.skip("EncryptedERC not configured");
		const client = createPublicClientFor(config);
		const eerc = getContract({
			abi: AUDITOR_ABI,
			address: eercAddr as `0x${string}`,
			client,
		});
		const key = (await eerc.read.auditorPublicKey()) as { x: bigint; y: bigint };
		expect(key.x === 0n && key.y === 0n).toBe(false);
	});
});
