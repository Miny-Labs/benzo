import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { processPoseidonEncryption } from "../../src/poseidon";
import type { PrivateGiftEscrow } from "../../typechain-types/contracts/benzo/PrivateGiftEscrow.sol/PrivateGiftEscrow";
import type { MockRegistrar } from "../../typechain-types/contracts/benzo/mocks/MockRegistrar";
import type { MockUSDC } from "../../typechain-types/contracts/benzo/mocks/MockUSDC";
import type { EncryptedERC } from "../../typechain-types/contracts/eerc/EncryptedERC";
import { PrivateGiftEscrow__factory } from "../../typechain-types/factories/contracts/benzo/PrivateGiftEscrow.sol/PrivateGiftEscrow__factory";
import { MockRegistrar__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockRegistrar__factory";
import { MockUSDC__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockUSDC__factory";
import { EncryptedERC__factory } from "../../typechain-types/factories/contracts/eerc/EncryptedERC__factory";
import { deployLibrary, getDecryptedBalance } from "../eerc/helpers";
import { User } from "../eerc/user";

const Status = {
	Created: 0n,
	Claimed: 1n,
	Refunded: 2n,
};

const GIFT_AMOUNT = 25_000_000n;
const EERC_DECIMALS = 6;

const signDigest = (wallet: ethers.HDNodeWallet, digest: string) =>
	ethers.Signature.from(wallet.signingKey.sign(digest)).serialized;

const pctFor = (value: bigint, publicKey: bigint[]) => {
	const { ciphertext, nonce, authKey } = processPoseidonEncryption(
		[value],
		publicKey,
	);
	return [...ciphertext, ...authKey, nonce] as [
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
	];
};

describe("PrivateGiftEscrow", () => {
	let owner: SignerWithAddress;
	let sender: SignerWithAddress;
	let stranger: SignerWithAddress;
	let ownerUser: User;
	let recipient: User;
	let unregistered: User;
	let registrar: MockRegistrar;
	let eerc: EncryptedERC;
	let usdc: MockUSDC;
	let eurc: MockUSDC;
	let escrow: PrivateGiftEscrow;
	let claimWallet: ethers.HDNodeWallet;

	const deployFixture = async () => {
		const signers = await ethers.getSigners();
		[owner, sender, stranger] = signers;
		ownerUser = new User(owner);
		recipient = new User(signers[3]);
		unregistered = new User(signers[4]);
		claimWallet = ethers.Wallet.createRandom();

		registrar = await new MockRegistrar__factory(owner).deploy();
		await registrar.waitForDeployment();
		await registrar.setUser(
			owner.address,
			ownerUser.publicKey[0],
			ownerUser.publicKey[1],
			true,
		);
		await registrar.setUser(
			recipient.signer.address,
			recipient.publicKey[0],
			recipient.publicKey[1],
			true,
		);
		await registrar.setUser(
			unregistered.signer.address,
			unregistered.publicKey[0],
			unregistered.publicKey[1],
			false,
		);

		const babyJubJub = await deployLibrary(owner);
		eerc = await new EncryptedERC__factory({
			"contracts/eerc/libraries/BabyJubJub.sol:BabyJubJub": babyJubJub,
		})
			.connect(owner)
			.deploy({
				registrar: await registrar.getAddress(),
				isConverter: true,
				name: "",
				symbol: "",
				mintVerifier: owner.address,
				withdrawVerifier: owner.address,
				transferVerifier: owner.address,
				burnVerifier: owner.address,
				decimals: EERC_DECIMALS,
			});
		await eerc.waitForDeployment();
		await eerc.setAuditorPublicKey(owner.address);

		usdc = await new MockUSDC__factory(owner).deploy("USD Coin", "USDC", 6);
		await usdc.waitForDeployment();
		eurc = await new MockUSDC__factory(owner).deploy("Euro Coin", "EURC", 6);
		await eurc.waitForDeployment();

		escrow = await new PrivateGiftEscrow__factory(owner).deploy(
			await eerc.getAddress(),
		);
		await escrow.waitForDeployment();
		await eerc.setAuthorizedDepositor(await escrow.getAddress(), true);

		for (const token of [usdc, eurc]) {
			await token.mint(sender.address, 1_000_000_000n);
			await token
				.connect(sender)
				.approve(await escrow.getAddress(), 1_000_000_000n);
		}
	};

	const createGift = async (token: MockUSDC, expiryOffset = 3600) => {
		const expiry = (await time.latest()) + expiryOffset;
		const tokenAddress = await token.getAddress();
		const tx = await escrow
			.connect(sender)
			.createGift(claimWallet.address, tokenAddress, GIFT_AMOUNT, expiry);
		const receipt = await tx.wait();
		const giftId = await escrow.giftCount();

		return { expiry, giftId, receipt, tokenAddress, tx };
	};

	const validSignature = async (
		giftId: bigint,
		recipientAddress: string,
		amountPCT: [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
	) =>
		signDigest(
			claimWallet,
			await escrow.claimDigest(giftId, recipientAddress, amountPCT),
		);

	beforeEach(async () => {
		await deployFixture();
	});

	for (const symbol of ["USDC", "EURC"] as const) {
		it(`creates and claims a ${symbol} gift into the recipient's private balance`, async () => {
			const token = symbol === "USDC" ? usdc : eurc;
			const { expiry, giftId, receipt, tokenAddress, tx } = await createGift(
				token,
			);
			const block = await ethers.provider.getBlock(receipt?.blockNumber ?? 0);
			const amountPCT = pctFor(GIFT_AMOUNT, recipient.publicKey);
			const sig = await validSignature(
				giftId,
				recipient.signer.address,
				amountPCT,
			);

			await expect(tx)
				.to.emit(escrow, "GiftCreated")
				.withArgs(
					giftId,
					sender.address,
					claimWallet.address,
					tokenAddress,
					GIFT_AMOUNT,
					expiry,
				);

			let gift = await escrow.getGift(giftId);
			expect(gift.sender).to.equal(sender.address);
			expect(gift.claimAddress).to.equal(claimWallet.address);
			expect(gift.token).to.equal(tokenAddress);
			expect(gift.recipient).to.equal(ethers.ZeroAddress);
			expect(gift.amount).to.equal(GIFT_AMOUNT);
			expect(gift.createdAt).to.equal(BigInt(block?.timestamp ?? 0));
			expect(gift.expiry).to.equal(BigInt(expiry));
			expect(gift.status).to.equal(Status.Created);
			expect(await token.balanceOf(await escrow.getAddress())).to.equal(
				GIFT_AMOUNT,
			);

			await expect(
				escrow
					.connect(stranger)
					.claim(giftId, recipient.signer.address, sig, amountPCT),
			)
				.to.emit(escrow, "GiftClaimed")
				.withArgs(
					giftId,
					recipient.signer.address,
					claimWallet.address,
					tokenAddress,
					GIFT_AMOUNT,
				);

			gift = await escrow.getGift(giftId);
			expect(gift.status).to.equal(Status.Claimed);
			expect(gift.recipient).to.equal(recipient.signer.address);
			expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
			expect(await token.balanceOf(await eerc.getAddress())).to.equal(
				GIFT_AMOUNT,
			);

			const balance = await eerc.getBalanceFromTokenAddress(
				recipient.signer.address,
				tokenAddress,
			);
			const decrypted = await getDecryptedBalance(
				recipient.privateKey,
				balance.amountPCTs,
				balance.balancePCT,
				balance.eGCT,
			);
			expect(decrypted).to.equal(GIFT_AMOUNT);
		});
	}

	it("rejects claims when the amountPCT differs from the signed digest", async () => {
		const { giftId } = await createGift(usdc);
		const signedPCT = pctFor(GIFT_AMOUNT, recipient.publicKey);
		const tamperedPCT = pctFor(GIFT_AMOUNT + 1n, recipient.publicKey);
		const sig = await validSignature(
			giftId,
			recipient.signer.address,
			signedPCT,
		);

		await expect(
			escrow
				.connect(stranger)
				.claim(giftId, recipient.signer.address, sig, tamperedPCT),
		).to.be.revertedWithCustomError(escrow, "InvalidSignature");
	});

	it("rejects claims when the recipient differs from the signed digest", async () => {
		const { giftId } = await createGift(usdc);
		const ownerPCT = pctFor(GIFT_AMOUNT, ownerUser.publicKey);
		const recipientPCT = pctFor(GIFT_AMOUNT, recipient.publicKey);
		const sig = await validSignature(
			giftId,
			recipient.signer.address,
			recipientPCT,
		);

		await expect(
			escrow.connect(stranger).claim(giftId, owner.address, sig, ownerPCT),
		).to.be.revertedWithCustomError(escrow, "InvalidSignature");
	});

	it("requires the recipient to be registered on eERC", async () => {
		const { giftId } = await createGift(usdc);
		const amountPCT = pctFor(GIFT_AMOUNT, unregistered.publicKey);
		const sig = await validSignature(
			giftId,
			unregistered.signer.address,
			amountPCT,
		);

		await expect(
			escrow
				.connect(stranger)
				.claim(giftId, unregistered.signer.address, sig, amountPCT),
		)
			.to.be.revertedWithCustomError(escrow, "RecipientNotRegistered")
			.withArgs(giftId, unregistered.signer.address);
	});

	it("rejects claim after expiry", async () => {
		const { expiry, giftId } = await createGift(usdc);
		const amountPCT = pctFor(GIFT_AMOUNT, recipient.publicKey);
		const sig = await validSignature(
			giftId,
			recipient.signer.address,
			amountPCT,
		);

		await time.setNextBlockTimestamp(expiry);

		await expect(
			escrow
				.connect(stranger)
				.claim(giftId, recipient.signer.address, sig, amountPCT),
		)
			.to.be.revertedWithCustomError(escrow, "GiftExpired")
			.withArgs(giftId, expiry, expiry);
	});

	it("refunds only the sender after expiry", async () => {
		const { expiry, giftId, tokenAddress } = await createGift(eurc);
		const senderBalanceBefore = await eurc.balanceOf(sender.address);
		const refundAttemptAt = (await time.latest()) + 1;

		await time.setNextBlockTimestamp(refundAttemptAt);
		await expect(escrow.connect(sender).refund(giftId))
			.to.be.revertedWithCustomError(escrow, "GiftNotExpired")
			.withArgs(giftId, expiry, refundAttemptAt);

		await time.increaseTo(expiry);

		await expect(escrow.connect(stranger).refund(giftId))
			.to.be.revertedWithCustomError(escrow, "OnlySender")
			.withArgs(giftId, stranger.address);

		await expect(escrow.connect(sender).refund(giftId))
			.to.emit(escrow, "GiftRefunded")
			.withArgs(giftId, sender.address, tokenAddress, GIFT_AMOUNT);

		const gift = await escrow.getGift(giftId);
		expect(gift.status).to.equal(Status.Refunded);
		expect(await eurc.balanceOf(sender.address)).to.equal(
			senderBalanceBefore + GIFT_AMOUNT,
		);
		expect(await eurc.balanceOf(await escrow.getAddress())).to.equal(0n);
	});
});
