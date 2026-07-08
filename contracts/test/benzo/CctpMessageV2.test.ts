import { expect } from "chai";
import { ethers } from "hardhat";
import type { Address } from "viem";
import { encodeHookData } from "../../src/cctp/hookData";
import { CctpMessageV2Harness__factory } from "../../typechain-types/factories/contracts/benzo/mocks/CctpMessageV2Harness__factory";

const REAL_FUJI_MESSAGE =
	"0x00000001000000010000001a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000003e800000000000000010000000000000000000000005425890298aed601595a70ab815c96711a31bc65000000000000000000000000e81f8bfd2a882a76fb1928efded78f6aaa5c4cf10000000000000000000000000000000000000000000000000000000004df19d0000000000000000000000000c5567a5e3370d4dbfb0540025078e283e36a363d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const REAL_FUJI_MESSAGE_BODY = `0x${REAL_FUJI_MESSAGE.slice(2 + 148 * 2)}`;

// Captured from Fuji MessageTransmitterV2 MessageSent(bytes):
// tx 0x249f8f44e82950c948e22380483d9b536dfd752a61f6e3702c1b35e622b5cbad,
// block 56880508.
describe("CctpMessageV2", () => {
	it("decodes a real Circle Fuji V2 message header fixture", async () => {
		const [owner] = await ethers.getSigners();
		const harness = await new CctpMessageV2Harness__factory(owner).deploy();
		await harness.waitForDeployment();

		const decoded = await harness.decodeHeader(REAL_FUJI_MESSAGE);

		expect(decoded.version).to.equal(1n);
		expect(decoded.sourceDomain).to.equal(1n);
		expect(decoded.destinationDomain).to.equal(26n);
		expect(decoded.nonce).to.equal(ethers.ZeroHash);
		expect(decoded.sender).to.equal(
			ethers.zeroPadValue("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", 32),
		);
		expect(decoded.recipient).to.equal(
			ethers.zeroPadValue("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", 32),
		);
		expect(decoded.destinationCaller).to.equal(ethers.ZeroHash);
		expect(decoded.minFinalityThreshold).to.equal(1000n);
		expect(decoded.finalityThresholdExecuted).to.equal(0n);
	});

	it("decodes a real Circle Fuji BurnMessageV2 body fixture", async () => {
		const [owner] = await ethers.getSigners();
		const harness = await new CctpMessageV2Harness__factory(owner).deploy();
		await harness.waitForDeployment();

		const decoded = await harness.decodeBurnCore(REAL_FUJI_MESSAGE_BODY);
		const fees = await harness.decodeBurnFees(REAL_FUJI_MESSAGE_BODY);

		expect(decoded.version).to.equal(1n);
		expect(decoded.burnToken).to.equal(
			ethers.getAddress("0x5425890298aed601595a70ab815c96711a31bc65"),
		);
		expect(decoded.mintRecipient).to.equal(
			ethers.getAddress("0xe81f8bfd2a882a76fb1928efded78f6aaa5c4cf1"),
		);
		expect(decoded.amount).to.equal(0x4df19d0n);
		expect(decoded.messageSender).to.equal(
			ethers.zeroPadValue("0xc5567a5e3370d4dbfb0540025078e283e36a363d", 32),
		);
		expect(fees.maxFee).to.equal(0n);
		expect(fees.feeExecuted).to.equal(0n);
		expect(fees.expirationBlock).to.equal(0n);
		expect(fees.mintedAmount).to.equal(0x4df19d0n);
		expect(await harness.burnHookData(REAL_FUJI_MESSAGE_BODY)).to.equal("0x");
	});

	it("decodes hookData byte-identically to the TypeScript codec", async () => {
		const [owner, user] = await ethers.getSigners();
		const harness = await new CctpMessageV2Harness__factory(owner).deploy();
		await harness.waitForDeployment();

		const sample = {
			user: user.address as Address,
			pkX: 14364545489025837921132814811087340315814711916725125522058321586402130033374n,
			pkY: 20925574508971738553590624529913342951840891855753600850246458133098606857912n,
		};
		const encoded = encodeHookData(sample);

		const decoded = await harness.decodeHookData(encoded);

		expect(decoded.user).to.equal(sample.user);
		expect(decoded.pkX).to.equal(sample.pkX);
		expect(decoded.pkY).to.equal(sample.pkY);
	});
});
