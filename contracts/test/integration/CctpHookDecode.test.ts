import { STABLECOINS } from "@benzo/config";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Address, Hex } from "viem";
import { decodeHookData, encodeHookData } from "../../src/cctp/hookData";
import type { CctpMessageV2Harness } from "../../typechain-types/contracts/benzo/mocks/CctpMessageV2Harness";
import type { MockCctpHookDataDecoder } from "../../typechain-types/contracts/mocks/MockCctpHookDataDecoder";
import { CctpMessageV2Harness__factory } from "../../typechain-types/factories/contracts/benzo/mocks/CctpMessageV2Harness__factory";
import { MockCctpHookDataDecoder__factory } from "../../typechain-types/factories/contracts/mocks/MockCctpHookDataDecoder__factory";
import { User } from "../eerc/user";

// TIER 1 — Fuji-fork integration. Confirms the real on-chain CctpMessageV2
// decoder (compiled Solidity) and the shared TypeScript hookData codec agree on
// the exact byte layout, using a config-resolved USDC address rather than any
// hardcoded 0x literal. Gated on FORK=fuji so it never runs in `pnpm test`.
const RUN_FORK = process.env.FORK === "fuji";
const describeFork = RUN_FORK ? describe : describe.skip;

const USDC_ADDRESS = STABLECOINS.fuji.USDC?.address as Address;

const u32 = (value: bigint | number) => ethers.toBeHex(value, 4);
const u256 = (value: bigint) => ethers.toBeHex(value, 32);
const b32 = (value: bigint) => ethers.toBeHex(value, 32);
const addressToBytes32 = (address: string) =>
	ethers.zeroPadValue(ethers.getAddress(address), 32);

describeFork("CCTP hookData / message decode (Fuji fork)", () => {
	let owner: SignerWithAddress;
	let user: User;
	let hookDecoder: MockCctpHookDataDecoder;
	let messageHarness: CctpMessageV2Harness;

	beforeEach(async () => {
		[owner] = await ethers.getSigners();
		user = new User(owner);
		hookDecoder = await new MockCctpHookDataDecoder__factory(owner).deploy();
		await hookDecoder.waitForDeployment();
		messageHarness = await new CctpMessageV2Harness__factory(owner).deploy();
		await messageHarness.waitForDeployment();
	});

	it("decodes hookData on-chain identically to the TypeScript codec", async () => {
		const hookData: Hex = encodeHookData({
			user: owner.address as Address,
			pkX: user.publicKey[0],
			pkY: user.publicKey[1],
		});

		const [onChainUser, onChainPkX, onChainPkY] =
			await hookDecoder.decode(hookData);
		const offChain = decodeHookData(hookData);

		expect(onChainUser).to.equal(offChain.user);
		expect(onChainPkX).to.equal(offChain.pkX);
		expect(onChainPkY).to.equal(offChain.pkY);
		expect(onChainUser).to.equal(owner.address);
	});

	it("decodes a full burn message body with an embedded hookData tuple", async () => {
		const amount = 2_500_000n;
		const feeExecuted = 12_500n;
		const hookData: Hex = encodeHookData({
			user: owner.address as Address,
			pkX: user.publicKey[0],
			pkY: user.publicKey[1],
		});

		const body = ethers.concat([
			u32(1),
			addressToBytes32(USDC_ADDRESS),
			addressToBytes32(owner.address),
			u256(amount),
			addressToBytes32(owner.address),
			u256(feeExecuted),
			u256(feeExecuted),
			u256(0n),
			hookData,
		]);

		const [, burnToken, mintRecipient, coreAmount] =
			await messageHarness.decodeBurnCore(body);
		expect(ethers.getAddress(burnToken)).to.equal(USDC_ADDRESS);
		expect(ethers.getAddress(mintRecipient)).to.equal(owner.address);
		expect(coreAmount).to.equal(amount);

		const [, feeOnChain, , mintedAmount] =
			await messageHarness.decodeBurnFees(body);
		expect(feeOnChain).to.equal(feeExecuted);
		// mintedAmount is the post-fee amount the router must credit.
		expect(mintedAmount).to.equal(amount - feeExecuted);

		const extractedHook = await messageHarness.burnHookData(body);
		const [hookUser] = await hookDecoder.decode(extractedHook);
		expect(hookUser).to.equal(owner.address);
	});

	it("round-trips { user, pkX, pkY } through the TypeScript codec", async () => {
		const sample = {
			user: owner.address as Address,
			pkX: user.publicKey[0],
			pkY: user.publicKey[1],
		};
		expect(decodeHookData(encodeHookData(sample))).to.deep.equal(sample);
		expect(b32(sample.pkX)).to.have.lengthOf(66);
	});
});
