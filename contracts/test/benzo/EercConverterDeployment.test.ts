import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "chai";
import { runEercSmoke } from "../../scripts/deploy/eerc-smoke";

describe("eERC converter deploy tooling", function () {
	this.timeout(600_000);

	const hardhatManifestPath = path.join(
		__dirname,
		"..",
		"..",
		"deployments",
		"hardhat.json",
	);
	let savedManifest: string | null = null;

	before(() => {
		// runEercSmoke persists deployments/hardhat.json. A file left over from a
		// prior process run holds addresses that don't exist on this fresh
		// in-process Hardhat chain, so the idempotent "already deployed" check
		// would reuse the wrong contracts. Snapshot any existing manifest and
		// start clean to keep the test hermetic.
		savedManifest = existsSync(hardhatManifestPath)
			? readFileSync(hardhatManifestPath, "utf8")
			: null;
		rmSync(hardhatManifestPath, { force: true });
	});

	after(() => {
		// Restore the developer's original manifest, or remove the one this test
		// wrote, so the run leaves local deployment state as it found it.
		if (savedManifest === null) {
			rmSync(hardhatManifestPath, { force: true });
		} else {
			writeFileSync(hardhatManifestPath, savedManifest);
		}
	});

	it("deploys the converter stack locally and completes the deposit-transfer-withdraw smoke", async () => {
		const result = await runEercSmoke({ deployIfMissing: true });
		const rerunResult = await runEercSmoke();

		for (const smokeResult of [result, rerunResult]) {
			expect(smokeResult.depositAmount).to.equal("100000000");
			expect(smokeResult.transferAmount).to.equal("25000000");
			expect(smokeResult.withdrawAmount).to.equal("5000000");
			expect(smokeResult.sender).to.match(/^0x[0-9a-fA-F]{40}$/);
			expect(smokeResult.receiver).to.match(/^0x[0-9a-fA-F]{40}$/);
		}
		expect(rerunResult.sender).to.equal(result.sender);
		expect(rerunResult.receiver).to.equal(result.receiver);
	});
});
