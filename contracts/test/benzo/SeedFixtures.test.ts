import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "chai";
import {
	accountOutput,
	buildGiftEscrowLink,
	buildGiftInvite,
	buildPayrollCsv,
	buildSeedConfig,
	deriveDemoAccounts,
	deterministicUuid,
	loadSeedState,
	writeSeedState,
	type SeedState,
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

	it("keeps escrow gift links byte-identical across seed reruns", () => {
		const config = buildSeedConfig(seedEnv);
		const firstRunInvite = buildGiftInvite(config);
		const secondRunInvite = buildGiftInvite(config);
		const firstRunLink = buildGiftEscrowLink(firstRunInvite.link, "12");
		const secondRunLink = buildGiftEscrowLink(secondRunInvite.link, "12");

		expect(secondRunLink).to.equal(firstRunLink);
		expect(Buffer.compare(Buffer.from(secondRunLink), Buffer.from(firstRunLink))).to.equal(
			0,
		);
		expect(secondRunLink).to.equal(`${firstRunInvite.link}?escrowGiftId=12`);
	});

	it("can ignore matching seed state for ephemeral hardhat runs", async () => {
		const config = buildSeedConfig(seedEnv);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "benzo-seed-"));
		const filePath = path.join(dir, "state.json");
		const persisted: SeedState = {
			chainId: 31_337,
			gift: {
				...buildGiftInvite(config),
				escrowGiftId: "12",
				escrowStatus: "created",
				escrowTxHash: "0xabc",
				expiresAt: "2026-01-01T00:00:00.000Z",
				link: buildGiftEscrowLink(buildGiftInvite(config).link, "12"),
			},
			seedId: config.seedId,
			target: config.target,
			transfers: {},
			version: 1,
		};

		try {
			await writeSeedState(filePath, persisted);

			const reused = await loadSeedState(filePath, config, 31_337);
			const ignored = await loadSeedState(filePath, config, 31_337, {
				ignoreCache: true,
			});

			expect(reused.gift?.link).to.equal(persisted.gift?.link);
			expect(ignored).to.deep.equal({
				chainId: 31_337,
				seedId: config.seedId,
				target: config.target,
				transfers: {},
				version: 1,
			});
		} finally {
			await fs.rm(dir, { force: true, recursive: true });
		}
	});
});
