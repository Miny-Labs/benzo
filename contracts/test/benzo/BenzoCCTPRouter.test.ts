import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Address, Hex } from "viem";
import { encodeHookData } from "../../src/cctp/hookData";
import { processPoseidonEncryption } from "../../src/poseidon";
import type { EncryptedERC } from "../../typechain-types/contracts/eerc/EncryptedERC";
import type { BenzoCCTPRouter } from "../../typechain-types/contracts/benzo/BenzoCCTPRouter";
import type { MockMessageTransmitterV2 } from "../../typechain-types/contracts/benzo/mocks/MockMessageTransmitterV2.sol/MockMessageTransmitterV2";
import type { MockRegistrar } from "../../typechain-types/contracts/benzo/mocks/MockRegistrar";
import type { MockUSDC } from "../../typechain-types/contracts/benzo/mocks/MockUSDC";
import { BenzoCCTPRouter__factory } from "../../typechain-types/factories/contracts/benzo/BenzoCCTPRouter__factory";
import { MockMessageTransmitterV2__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockMessageTransmitterV2.sol/MockMessageTransmitterV2__factory";
import { MockRegistrar__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockRegistrar__factory";
import { MockUSDC__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockUSDC__factory";
import { EncryptedERC__factory } from "../../typechain-types/factories/contracts/eerc/EncryptedERC__factory";
import { deployLibrary, decryptPCT, getDecryptedBalance } from "../eerc/helpers";
import { User } from "../eerc/user";

const ZERO_BYTES32 = ethers.ZeroHash;
const ATTESTATION = "0x";
const EERC_DECIMALS = 6;

const u32 = (value: bigint | number) => ethers.toBeHex(value, 4);
const u256 = (value: bigint) => ethers.toBeHex(value, 32);
const b32 = (value: bigint) => ethers.toBeHex(value, 32);
const addressToBytes32 = (address: string) =>
	ethers.zeroPadValue(ethers.getAddress(address), 32);

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

const hookFor = (user: User, address?: string): Hex =>
	encodeHookData({
		user: (address ?? user.signer.address) as Address,
		pkX: user.publicKey[0],
		pkY: user.publicKey[1],
	});

const buildBurnBody = ({
	amount,
	burnToken,
	feeExecuted = 0n,
	hookData,
	maxFee = feeExecuted,
	messageSender,
	mintRecipient,
}: {
	amount: bigint;
	burnToken: string;
	feeExecuted?: bigint;
	hookData: Hex;
	maxFee?: bigint;
	messageSender: string;
	mintRecipient: string;
}) =>
	ethers.concat([
		u32(1),
		addressToBytes32(burnToken),
		addressToBytes32(mintRecipient),
		u256(amount),
		addressToBytes32(messageSender),
		u256(maxFee),
		u256(feeExecuted),
		u256(0n),
		hookData,
	]);

const buildMessage = ({
	body,
	nonce,
	tokenMessenger,
}: {
	body: string;
	nonce: bigint;
	tokenMessenger: string;
}) =>
	ethers.concat([
		u32(1),
		u32(0),
		u32(1),
		b32(nonce),
		addressToBytes32(tokenMessenger),
		addressToBytes32(tokenMessenger),
		ZERO_BYTES32,
		u32(1000),
		u32(2000),
		body,
	]);

describe("BenzoCCTPRouter", () => {
	let owner: SignerWithAddress;
	let relayer: SignerWithAddress;
	let recipientSigner: SignerWithAddress;
	let fallbackRecipient: SignerWithAddress;
	let ownerUser: User;
	let recipient: User;
	let unregistered: User;
	let registrar: MockRegistrar;
	let eerc: EncryptedERC;
	let usdc: MockUSDC;
	let blockedToken: MockUSDC;
	let transmitter: MockMessageTransmitterV2;
	let router: BenzoCCTPRouter;
	let eercAddress: string;
	let usdcAddress: string;
	let blockedTokenAddress: string;
	let routerAddress: string;
	let transmitterAddress: string;

	const deployFixture = async () => {
		const signers = await ethers.getSigners();
		[owner, relayer, recipientSigner, fallbackRecipient] = signers;
		ownerUser = new User(owner);
		recipient = new User(recipientSigner);
		unregistered = new User(signers[4]);

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
		eercAddress = await eerc.getAddress();
		await eerc.setAuditorPublicKey(owner.address);

		usdc = await new MockUSDC__factory(owner).deploy("USD Coin", "USDC", 6);
		await usdc.waitForDeployment();
		blockedToken = await new MockUSDC__factory(owner).deploy(
			"Blocked USD",
			"bUSD",
			6,
		);
		await blockedToken.waitForDeployment();
		usdcAddress = await usdc.getAddress();
		blockedTokenAddress = await blockedToken.getAddress();

		transmitter = await new MockMessageTransmitterV2__factory(owner).deploy();
		await transmitter.waitForDeployment();
		transmitterAddress = await transmitter.getAddress();

		router = await new BenzoCCTPRouter__factory(owner).deploy(
			transmitterAddress,
			eercAddress,
			await registrar.getAddress(),
		);
		await router.waitForDeployment();
		routerAddress = await router.getAddress();

		await router.setAllowedToken(usdcAddress, true);
		await router.setRelayer(relayer.address, true);
		await eerc.setAuthorizedDepositor(routerAddress, true);
	};

	const messageFor = ({
		amount,
		burnToken = usdcAddress,
		feeExecuted,
		hookData = hookFor(recipient),
		mintRecipient = routerAddress,
		nonce = 1n,
	}: {
		amount: bigint;
		burnToken?: string;
		feeExecuted?: bigint;
		hookData?: Hex;
		mintRecipient?: string;
		nonce?: bigint;
	}) =>
		buildMessage({
			nonce,
			tokenMessenger: transmitterAddress,
			body: buildBurnBody({
				amount,
				burnToken,
				feeExecuted,
				hookData,
				messageSender: owner.address,
				mintRecipient,
			}),
		});

	beforeEach(async () => {
		await deployFixture();
	});

	it("settles a valid attested message into the user's eERC balance", async () => {
		const amount = 1_250_000n;
		const nonce = 11n;
		const message = messageFor({ amount, nonce });

		await expect(
			router
				.connect(relayer)
				.settleDeposit(message, ATTESTATION, pctFor(amount, recipient.publicKey)),
		)
			.to.emit(router, "OnrampSettled")
			.withArgs(recipient.signer.address, usdcAddress, amount, b32(nonce));

		expect(await usdc.balanceOf(routerAddress)).to.equal(0n);
		expect(await usdc.balanceOf(eercAddress)).to.equal(amount);

		const balance = await eerc.getBalanceFromTokenAddress(
			recipient.signer.address,
			usdcAddress,
		);
		const decrypted = await getDecryptedBalance(
			recipient.privateKey,
			balance.amountPCTs,
			balance.balancePCT,
			balance.eGCT,
		);
		expect(decrypted).to.equal(amount);
	});

	it("uses the post-fee CCTP amount and matching recomputed amountPCT", async () => {
		const requestedAmount = 1_000_000n;
		const feeExecuted = 25_000n;
		const mintedAmount = requestedAmount - feeExecuted;
		const message = messageFor({
			amount: requestedAmount,
			feeExecuted,
			nonce: 12n,
		});

		await expect(
			router
				.connect(relayer)
				.settleDeposit(
					message,
					ATTESTATION,
					pctFor(mintedAmount, recipient.publicKey),
				),
		)
			.to.emit(router, "OnrampSettled")
			.withArgs(recipient.signer.address, usdcAddress, mintedAmount, b32(12n));

		expect(await usdc.balanceOf(routerAddress)).to.equal(0n);
		expect(await usdc.balanceOf(eercAddress)).to.equal(mintedAmount);

		const balance = await eerc.getBalanceFromTokenAddress(
			recipient.signer.address,
			usdcAddress,
		);
		const decryptedHistory = await decryptPCT(
			recipient.privateKey,
			balance.amountPCTs[0].pct,
		);
		expect(BigInt(decryptedHistory[0])).to.equal(mintedAmount);
	});

	it("reverts replayed CCTP messages without double crediting", async () => {
		const amount = 500_000n;
		const message = messageFor({ amount, nonce: 13n });
		const amountPCT = pctFor(amount, recipient.publicKey);

		await router.connect(relayer).settleDeposit(message, ATTESTATION, amountPCT);
		await expect(
			router.connect(relayer).settleDeposit(message, ATTESTATION, amountPCT),
		).to.be.revertedWithCustomError(transmitter, "CctpNonceAlreadyUsed");

		expect(await usdc.balanceOf(eercAddress)).to.equal(amount);
	});

	it("rejects a non-allowlisted token without stranding the minted funds", async () => {
		const amount = 500_000n;
		const message = messageFor({
			amount,
			burnToken: blockedTokenAddress,
			nonce: 14n,
		});

		await expect(
			router
				.connect(relayer)
				.settleDeposit(message, ATTESTATION, pctFor(amount, recipient.publicKey)),
		)
			.to.be.revertedWithCustomError(router, "TokenNotAllowed")
			.withArgs(blockedTokenAddress);
		expect(await blockedToken.balanceOf(routerAddress)).to.equal(0n);
	});

	it("rejects an unregistered user with a relayer-routable typed error", async () => {
		const amount = 500_000n;
		const message = messageFor({
			amount,
			hookData: hookFor(unregistered),
			nonce: 15n,
		});

		await expect(
			router
				.connect(relayer)
				.settleDeposit(message, ATTESTATION, pctFor(amount, unregistered.publicKey)),
		)
			.to.be.revertedWithCustomError(router, "RecipientNotRegistered")
			.withArgs(unregistered.signer.address);
		expect(await usdc.balanceOf(routerAddress)).to.equal(0n);
	});

	it("rejects messages whose mintRecipient is not the router", async () => {
		const amount = 500_000n;
		const message = messageFor({
			amount,
			mintRecipient: fallbackRecipient.address,
			nonce: 16n,
		});

		await expect(
			router
				.connect(relayer)
				.settleDeposit(message, ATTESTATION, pctFor(amount, recipient.publicKey)),
		)
			.to.be.revertedWithCustomError(router, "MintRecipientMismatch")
			.withArgs(routerAddress, fallbackRecipient.address);
		expect(await usdc.balanceOf(fallbackRecipient.address)).to.equal(0n);
	});

	it("rejects hookData public keys that do not match the registered key", async () => {
		const amount = 500_000n;
		const badHookData = encodeHookData({
			user: recipient.signer.address as Address,
			pkX: recipient.publicKey[0] + 1n,
			pkY: recipient.publicKey[1],
		});
		const message = messageFor({ amount, hookData: badHookData, nonce: 17n });

		await expect(
			router
				.connect(relayer)
				.settleDeposit(message, ATTESTATION, pctFor(amount, recipient.publicKey)),
		)
			.to.be.revertedWithCustomError(router, "PublicKeyMismatch")
			.withArgs(
				recipient.signer.address,
				recipient.publicKey[0],
				recipient.publicKey[1],
				recipient.publicKey[0] + 1n,
				recipient.publicKey[1],
			);
		expect(await usdc.balanceOf(routerAddress)).to.equal(0n);
	});

	it("restricts settlement to owner-approved relayers", async () => {
		const amount = 500_000n;
		const message = messageFor({ amount, nonce: 18n });

		await expect(
			router
				.connect(recipientSigner)
				.settleDeposit(message, ATTESTATION, pctFor(amount, recipient.publicKey)),
		)
			.to.be.revertedWithCustomError(router, "NotRelayer")
			.withArgs(recipientSigner.address);
	});

	it("lets the owner rescue stranded token dust", async () => {
		const dust = 123n;
		await usdc.mint(routerAddress, dust);

		await expect(router.connect(relayer).rescue(usdcAddress, fallbackRecipient.address))
			.to.be.reverted;

		await expect(router.rescue(usdcAddress, fallbackRecipient.address))
			.to.emit(router, "Rescue")
			.withArgs(usdcAddress, fallbackRecipient.address, dust);

		expect(await usdc.balanceOf(routerAddress)).to.equal(0n);
		expect(await usdc.balanceOf(fallbackRecipient.address)).to.equal(dust);
	});
});
