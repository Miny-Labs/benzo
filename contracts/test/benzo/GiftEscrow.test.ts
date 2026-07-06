import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { GiftEscrow } from "../../typechain-types/contracts/benzo/GiftEscrow";
import type { SimpleERC20 } from "../../typechain-types/contracts/eerc/tokens/SimpleERC20";
import { GiftEscrow__factory } from "../../typechain-types/factories/contracts/benzo/GiftEscrow__factory";
import { SimpleERC20__factory } from "../../typechain-types/factories/contracts/eerc/tokens/SimpleERC20__factory";

const Status = {
	Created: 0n,
	Claimed: 1n,
	Refunded: 2n,
};

const GIFT_AMOUNT = 25_000_000n;

const signDigest = (wallet: ethers.HDNodeWallet, digest: string) =>
	ethers.Signature.from(wallet.signingKey.sign(digest)).serialized;

describe("GiftEscrow", () => {
	let token: SimpleERC20;
	let escrow: GiftEscrow;
	let sender: SignerWithAddress;
	let recipient: SignerWithAddress;
	let stranger: SignerWithAddress;
	let claimWallet: ethers.HDNodeWallet;

	const deployFixture = async () => {
		[sender, recipient, stranger] = await ethers.getSigners();
		claimWallet = ethers.Wallet.createRandom();

		const tokenFactory = new SimpleERC20__factory(sender);
		token = await tokenFactory.deploy("Test USDC", "tUSDC", 6);
		await token.waitForDeployment();

		const escrowFactory = new GiftEscrow__factory(sender);
		escrow = await escrowFactory.deploy(await token.getAddress());
		await escrow.waitForDeployment();

		await token.mint(sender.address, 1_000_000_000n);
		await token.connect(sender).approve(await escrow.getAddress(), 1_000_000_000n);
	};

	const createGift = async (expiryOffset = 3600) => {
		const expiry = (await time.latest()) + expiryOffset;
		const tx = await escrow
			.connect(sender)
			.createGift(claimWallet.address, GIFT_AMOUNT, expiry);
		const receipt = await tx.wait();
		const giftId = await escrow.giftCount();

		return { expiry, giftId, receipt, tx };
	};

	const validSignature = async (
		giftId: bigint,
		recipientAddress = recipient.address,
	) => signDigest(claimWallet, await escrow.claimDigest(giftId, recipientAddress));

	beforeEach(async () => {
		await deployFixture();
	});

	it("creates and claims a gift with a recipient-bound claim signature", async () => {
		const { expiry, giftId, receipt, tx } = await createGift();
		const block = await ethers.provider.getBlock(receipt?.blockNumber ?? 0);
		const sig = await validSignature(giftId);

		await expect(tx)
			.to.emit(escrow, "GiftCreated")
			.withArgs(giftId, sender.address, claimWallet.address, GIFT_AMOUNT, expiry);

		let gift = await escrow.getGift(giftId);
		expect(gift.sender).to.equal(sender.address);
		expect(gift.claimAddress).to.equal(claimWallet.address);
		expect(gift.recipient).to.equal(ethers.ZeroAddress);
		expect(gift.amount).to.equal(GIFT_AMOUNT);
		expect(gift.createdAt).to.equal(BigInt(block?.timestamp ?? 0));
		expect(gift.expiry).to.equal(BigInt(expiry));
		expect(gift.status).to.equal(Status.Created);
		expect(await token.balanceOf(await escrow.getAddress())).to.equal(GIFT_AMOUNT);

		await expect(escrow.connect(stranger).claim(giftId, recipient.address, sig))
			.to.emit(escrow, "GiftClaimed")
			.withArgs(giftId, recipient.address, claimWallet.address);

		gift = await escrow.getGift(giftId);
		expect(gift.status).to.equal(Status.Claimed);
		expect(gift.recipient).to.equal(recipient.address);
		expect(await token.balanceOf(recipient.address)).to.equal(GIFT_AMOUNT);
		expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
	});

	it("rejects claims signed by a different key", async () => {
		const { giftId } = await createGift();
		const wrongWallet = ethers.Wallet.createRandom();
		const sig = signDigest(
			wrongWallet,
			await escrow.claimDigest(giftId, recipient.address),
		);

		await expect(
			escrow.connect(stranger).claim(giftId, recipient.address, sig),
		).to.be.revertedWithCustomError(escrow, "InvalidSignature").withArgs(
			giftId,
			wrongWallet.address,
		);
	});

	it("rejects signature replay across gift ids", async () => {
		const firstGift = await createGift();
		const secondGift = await createGift();
		const sigForFirstGift = await validSignature(firstGift.giftId);

		await expect(
			escrow
				.connect(stranger)
				.claim(secondGift.giftId, recipient.address, sigForFirstGift),
		).to.be.revertedWithCustomError(escrow, "InvalidSignature");
	});

	it("rejects signature replay across chain ids", async () => {
		const { giftId } = await createGift();
		const wrongChainDigest = ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(
				["address", "uint256", "uint256", "address"],
				[await escrow.getAddress(), 43113n, giftId, recipient.address],
			),
		);
		const sig = signDigest(claimWallet, wrongChainDigest);

		await expect(
			escrow.connect(stranger).claim(giftId, recipient.address, sig),
		).to.be.revertedWithCustomError(escrow, "InvalidSignature");
	});

	it("rejects double-claim", async () => {
		const { giftId } = await createGift();
		const sig = await validSignature(giftId);

		await escrow.connect(stranger).claim(giftId, recipient.address, sig);

		await expect(
			escrow.connect(stranger).claim(giftId, recipient.address, sig),
		).to.be.revertedWithCustomError(escrow, "GiftNotCreated").withArgs(
			giftId,
			Status.Claimed,
		);
	});

	it("rejects claim after expiry", async () => {
		const { expiry, giftId } = await createGift();
		const sig = await validSignature(giftId);

		await time.setNextBlockTimestamp(expiry);

		await expect(escrow.connect(stranger).claim(giftId, recipient.address, sig))
			.to.be.revertedWithCustomError(escrow, "GiftExpired")
			.withArgs(giftId, expiry, expiry);
	});

	it("rejects refund before expiry", async () => {
		const { expiry, giftId } = await createGift();
		const refundAttemptAt = (await time.latest()) + 1;

		await time.setNextBlockTimestamp(refundAttemptAt);

		await expect(escrow.connect(sender).refund(giftId))
			.to.be.revertedWithCustomError(escrow, "GiftNotExpired")
			.withArgs(giftId, expiry, refundAttemptAt);
	});

	it("refunds sender after expiry", async () => {
		const { expiry, giftId } = await createGift();
		const senderBalanceBefore = await token.balanceOf(sender.address);

		await time.increaseTo(expiry);

		await expect(escrow.connect(sender).refund(giftId))
			.to.emit(escrow, "GiftRefunded")
			.withArgs(giftId, sender.address);

		const gift = await escrow.getGift(giftId);
		expect(gift.status).to.equal(Status.Refunded);
		expect(await token.balanceOf(sender.address)).to.equal(
			senderBalanceBefore + GIFT_AMOUNT,
		);
		expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
	});

	it("rejects claim after refund", async () => {
		const { expiry, giftId } = await createGift();
		const sig = await validSignature(giftId);

		await time.increaseTo(expiry);
		await escrow.connect(sender).refund(giftId);

		await expect(
			escrow.connect(stranger).claim(giftId, recipient.address, sig),
		).to.be.revertedWithCustomError(escrow, "GiftNotCreated").withArgs(
			giftId,
			Status.Refunded,
		);
	});
});
