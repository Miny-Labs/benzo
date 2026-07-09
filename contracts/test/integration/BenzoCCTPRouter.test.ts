import {
	CCTP_PROTOCOL,
	CCTP_SOURCE_CHAINS,
	STABLECOINS,
	deploymentsByNetwork,
} from "@benzo/config";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Address, Hex } from "viem";
import { encodeHookData } from "../../src/cctp/hookData";
import { buildAmountPCT, decryptPCT } from "../../src/eerc-client";
import type { BenzoCCTPRouter } from "../../typechain-types/contracts/benzo/BenzoCCTPRouter";
import type { EncryptedERC } from "../../typechain-types/contracts/eerc/EncryptedERC";
import type { MockMessageTransmitterV2 } from "../../typechain-types/contracts/benzo/mocks/MockMessageTransmitterV2.sol/MockMessageTransmitterV2";
import type { MockRegistrar } from "../../typechain-types/contracts/benzo/mocks/MockRegistrar";
import { BenzoCCTPRouter__factory } from "../../typechain-types/factories/contracts/benzo/BenzoCCTPRouter__factory";
import { MockMessageTransmitterV2__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockMessageTransmitterV2.sol/MockMessageTransmitterV2__factory";
import { MockRegistrar__factory } from "../../typechain-types/factories/contracts/benzo/mocks/MockRegistrar__factory";
import { EncryptedERC__factory } from "../../typechain-types/factories/contracts/eerc/EncryptedERC__factory";
import { deployLibrary, getDecryptedBalance } from "../eerc/helpers";
import { User } from "../eerc/user";

// TIER 1 — Fuji-fork integration. Runs ONLY under FORK=fuji (see
// hardhat.config.ts), so it never fires in the default `pnpm test`. It forks
// Fuji at a pinned block so real Circle USDC (config-resolved, not hardcoded)
// runs with its deployed bytecode; the router's eERC deposit path is exercised
// against that real token. Circle's off-chain attestation is the one boundary
// we cannot reproduce on a fork, so a MockMessageTransmitterV2 stands in for the
// receive step while everything downstream — real USDC transfers, the router's
// decode/validate, and the eERC converter deposit — is real.
const RUN_FORK = process.env.FORK === "fuji";
const describeFork = RUN_FORK ? describe : describe.skip;

// Config-driven addresses. No 0x literals in this test body (an M4 invariant).
const LOCAL_USDC_ADDRESS = STABLECOINS.fuji.USDC?.address as Address;
const REMOTE_USDC_ADDRESS = CCTP_SOURCE_CHAINS.staging.optimism?.tokens.USDC
	?.address as Address;
const FUJI_CCTP = deploymentsByNetwork.fuji.contracts.cctp;
const REAL_MESSAGE_TRANSMITTER = FUJI_CCTP?.messageTransmitter as Address;
const REAL_TOKEN_MESSENGER = CCTP_PROTOCOL.staging.tokenMessenger;

const EERC_DECIMALS = 6;
const ATTESTATION = "0x";
const ZERO_BYTES32 = ethers.ZeroHash;
const GAS_BALANCE = "0x3635C9ADC5DEA00000"; // 1000 ETH-equiv for impersonated accounts.

// Minimal Circle FiatToken surface: mint real USDC on the fork by impersonating
// the token's masterMinter and configuring the mock transmitter as a minter.
const FIAT_TOKEN_ABI = [
	"function masterMinter() view returns (address)",
	"function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
	"function balanceOf(address account) view returns (uint256)",
	"function decimals() view returns (uint8)",
];

const u32 = (value: bigint | number) => ethers.toBeHex(value, 4);
const u256 = (value: bigint) => ethers.toBeHex(value, 32);
const b32 = (value: bigint) => ethers.toBeHex(value, 32);
const addressToBytes32 = (address: string) =>
	ethers.zeroPadValue(ethers.getAddress(address), 32);

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

describeFork("BenzoCCTPRouter (Fuji fork, real USDC)", () => {
	let owner: SignerWithAddress;
	let relayer: SignerWithAddress;
	let recipientSigner: SignerWithAddress;
	let ownerUser: User;
	let recipient: User;
	let unregistered: User;
	let registrar: MockRegistrar;
	let eerc: EncryptedERC;
	let transmitter: MockMessageTransmitterV2;
	let router: BenzoCCTPRouter;
	let eercAddress: string;
	let routerAddress: string;
	let transmitterAddress: string;

	const impersonate = async (address: string): Promise<SignerWithAddress> => {
		await network.provider.request({
			method: "hardhat_impersonateAccount",
			params: [address],
		});
		await network.provider.send("hardhat_setBalance", [address, GAS_BALANCE]);
		return ethers.getSigner(address);
	};

	const deployFixture = async () => {
		const signers = await ethers.getSigners();
		[owner, relayer, recipientSigner] = signers;
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

		await router.setAllowedToken(LOCAL_USDC_ADDRESS, true);
		await router.setRemoteToken(REMOTE_USDC_ADDRESS, LOCAL_USDC_ADDRESS);
		await router.setRelayer(relayer.address, true);
		await eerc.setAuthorizedDepositor(routerAddress, true);
		await transmitter.setRemoteToken(REMOTE_USDC_ADDRESS, LOCAL_USDC_ADDRESS);

		// Authorize the mock transmitter to mint real Circle USDC on the fork so
		// receiveMessage credits the router exactly as a real CCTP mint would.
		const usdcReader = new ethers.Contract(
			LOCAL_USDC_ADDRESS,
			FIAT_TOKEN_ABI,
			owner,
		);
		const masterMinter: string = await usdcReader.masterMinter();
		const masterMinterSigner = await impersonate(masterMinter);
		const usdcAsMaster = new ethers.Contract(
			LOCAL_USDC_ADDRESS,
			FIAT_TOKEN_ABI,
			masterMinterSigner,
		);
		await usdcAsMaster.configureMinter(transmitterAddress, ethers.MaxUint256);
	};

	const messageFor = ({
		amount,
		burnToken = REMOTE_USDC_ADDRESS,
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

	const usdcBalanceOf = async (address: string): Promise<bigint> => {
		const usdc = new ethers.Contract(LOCAL_USDC_ADDRESS, FIAT_TOKEN_ABI, owner);
		return usdc.balanceOf(address);
	};

	beforeEach(async () => {
		await deployFixture();
	});

	it("forks against real deployed bytecode for USDC and CCTP", async () => {
		expect(REMOTE_USDC_ADDRESS).to.not.equal(LOCAL_USDC_ADDRESS);
		expect(await ethers.provider.getCode(LOCAL_USDC_ADDRESS)).to.not.equal("0x");
		expect(
			await ethers.provider.getCode(REAL_MESSAGE_TRANSMITTER),
		).to.not.equal("0x");
		expect(await ethers.provider.getCode(REAL_TOKEN_MESSENGER)).to.not.equal(
			"0x",
		);
	});

	it("credits the user's eERC balance and leaves the router balance at 0", async () => {
		const amount = 1_250_000n;
		const nonce = 11n;
		const message = messageFor({ amount, nonce });

		await expect(
			router
				.connect(relayer)
				.settleDeposit(
					message,
					ATTESTATION,
					buildAmountPCT(amount, recipient.publicKey),
				),
		)
			.to.emit(router, "OnrampSettled")
			.withArgs(
				recipient.signer.address,
				LOCAL_USDC_ADDRESS,
				amount,
				b32(nonce),
			);

		// Happy path: the user's encrypted balance goes UP by `amount` and the
		// local Fuji token is forwarded into the converter.
		expect(await usdcBalanceOf(routerAddress)).to.equal(0n);
		expect(await usdcBalanceOf(eercAddress)).to.equal(amount);

		const balance = await eerc.getBalanceFromTokenAddress(
			recipient.signer.address,
			LOCAL_USDC_ADDRESS,
		);
		const decrypted = await getDecryptedBalance(
			recipient.privateKey,
			balance.amountPCTs,
			balance.balancePCT,
			balance.eGCT,
		);
		expect(decrypted).to.equal(amount);
	});

	it("recomputes the amountPCT to the ACTUAL minted amount on a fee shortfall", async () => {
		const requestedAmount = 1_000_000n;
		const feeExecuted = 25_000n;
		const mintedAmount = requestedAmount - feeExecuted;
		const message = messageFor({
			amount: requestedAmount,
			feeExecuted,
			nonce: 12n,
		});

		// The ciphertext MUST be built from the minted (post-fee) amount. Building
		// it from `requestedAmount` would encode a value the on-chain token
		// transfer never delivered — this asserts the two amounts genuinely differ
		// so the "wrong amount" path is a real failure mode, not a no-op.
		const wrongPct = buildAmountPCT(requestedAmount, recipient.publicKey);
		expect(decryptPCT(recipient.privateKey, wrongPct)[0]).to.equal(
			requestedAmount,
		);
		expect(mintedAmount).to.not.equal(requestedAmount);

		await expect(
			router
				.connect(relayer)
				.settleDeposit(
					message,
					ATTESTATION,
					buildAmountPCT(mintedAmount, recipient.publicKey),
				),
		)
			.to.emit(router, "OnrampSettled")
			.withArgs(
				recipient.signer.address,
				LOCAL_USDC_ADDRESS,
				mintedAmount,
				b32(12n),
			);

		expect(await usdcBalanceOf(routerAddress)).to.equal(0n);
		expect(await usdcBalanceOf(eercAddress)).to.equal(mintedAmount);

		const balance = await eerc.getBalanceFromTokenAddress(
			recipient.signer.address,
			LOCAL_USDC_ADDRESS,
		);
		const decryptedHistory = decryptPCT(
			recipient.privateKey,
			balance.amountPCTs[0].pct,
		);
		expect(decryptedHistory[0]).to.equal(mintedAmount);

		// The recorded amount decrypts to the minted value — NOT the requested one.
		expect(decryptedHistory[0]).to.not.equal(requestedAmount);
	});

	it("rejects a replayed CCTP message without double crediting", async () => {
		const amount = 500_000n;
		const message = messageFor({ amount, nonce: 13n });
		const amountPCT = buildAmountPCT(amount, recipient.publicKey);

		await router.connect(relayer).settleDeposit(message, ATTESTATION, amountPCT);
		await expect(
			router.connect(relayer).settleDeposit(message, ATTESTATION, amountPCT),
		).to.be.revertedWithCustomError(transmitter, "CctpNonceAlreadyUsed");

		expect(await usdcBalanceOf(eercAddress)).to.equal(amount);
	});

	it("parks an unregistered recipient by reverting without stranding funds", async () => {
		const amount = 500_000n;
		const message = messageFor({
			amount,
			hookData: hookFor(unregistered),
			nonce: 14n,
		});

		await expect(
			router
				.connect(relayer)
				.settleDeposit(
					message,
					ATTESTATION,
					buildAmountPCT(amount, unregistered.publicKey),
				),
		)
			.to.be.revertedWithCustomError(router, "RecipientNotRegistered")
			.withArgs(unregistered.signer.address);

		// The revert rolls back the mint, so no real USDC is stranded on the router.
		expect(await usdcBalanceOf(routerAddress)).to.equal(0n);
	});
});
