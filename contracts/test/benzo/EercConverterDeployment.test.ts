import { expect } from "chai";
import { runEercSmoke } from "../../scripts/deploy/eerc-smoke";

describe("eERC converter deploy tooling", function () {
	this.timeout(600_000);

	it("deploys the converter stack locally and completes the deposit-transfer-withdraw smoke", async () => {
		const result = await runEercSmoke({ deployIfMissing: true });

		expect(result.depositAmount).to.equal("100000000");
		expect(result.transferAmount).to.equal("25000000");
		expect(result.withdrawAmount).to.equal("5000000");
		expect(result.sender).to.match(/^0x[0-9a-fA-F]{40}$/);
		expect(result.receiver).to.match(/^0x[0-9a-fA-F]{40}$/);
	});
});
