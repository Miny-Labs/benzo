import { rmSync } from "node:fs";
import path from "node:path";
import { expect } from "chai";
import { runEercSmoke } from "../../scripts/deploy/eerc-smoke";

describe("eERC converter deploy tooling", function () {
	this.timeout(600_000);

	before(() => {
		// runEercSmoke persists deployments/hardhat.json. A file left over from a
		// prior process run holds addresses that don't exist on this fresh
		// in-process Hardhat chain, so the idempotent "already deployed" check
		// would reuse the wrong contracts. Clear it to keep the test hermetic.
		rmSync(path.join(__dirname, "..", "..", "deployments", "hardhat.json"), {
			force: true,
		});
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
