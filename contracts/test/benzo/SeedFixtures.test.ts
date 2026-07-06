import { expect } from "chai";
import {
	accountOutput,
	buildGiftInvite,
	buildPayrollCsv,
	buildSeedConfig,
	deriveDemoAccounts,
	deterministicUuid,
} from "../../scripts/seed-fixtures";

const seedEnv = {
	BENZO_SEED_COUNT: "4",
	BENZO_SEED_PHRASE: "local demo seed phrase for tests only",
	BENZO_SEED_TARGET: "local",
} satisfies NodeJS.ProcessEnv;

describe("seed fixtures", () => {
	it("derives deterministic accounts and public-safe account output", () => {
		const config = buildSeedConfig(seedEnv);
		const first = deriveDemoAccounts(config);
		const second = deriveDemoAccounts(config);
		const fuji = deriveDemoAccounts(
			buildSeedConfig({ ...seedEnv, BENZO_SEED_TARGET: "fuji" }),
		);

		expect(first.map((account) => account.address)).to.deep.equal(
			second.map((account) => account.address),
		);
		expect(first[0]?.address).not.to.equal(fuji[0]?.address);
		expect(first.map((account) => account.handle)).to.deep.equal([
			"maya",
			"noah",
			"asha",
			"leo",
		]);
		expect(JSON.stringify(accountOutput(first[0]!))).not.to.contain(
			first[0]!.privateKey,
		);
	});

	it("builds stable payroll and gift-link fixtures", () => {
		const config = buildSeedConfig(seedEnv);
		const accounts = deriveDemoAccounts(config);
		const gift = buildGiftInvite(config);

		expect(buildPayrollCsv(accounts)).to.equal(
			[
				"recipient,amount",
				"@noah,1250.00",
				"@asha,980.50",
				"@leo,1425.75",
			].join("\n"),
		);
		expect(gift).to.deep.equal(buildGiftInvite(config));
		expect(gift.inviteId).to.equal(deterministicUuid(`gift-invite:${gift.tokenHash}`));
		expect(gift.link).to.match(/^benzo:\/\/gift\//);
	});
});
