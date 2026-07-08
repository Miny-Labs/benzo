import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";
import { ethers, zkit } from "hardhat";
import type { RegistrationCircuit } from "../generated-types/zkit";
import { processPoseidonEncryption } from "../src";
import { type SimpleERC20, SimpleERC20__factory } from "../typechain-types";
import type { EncryptedERC } from "../typechain-types/contracts/eerc/EncryptedERC";
import type { Registrar } from "../typechain-types/contracts/eerc/Registrar";
import {
	EncryptedERC__factory,
	Registrar__factory,
} from "../typechain-types/factories/contracts/eerc";
import { deployLibrary, deployVerifiers, getDecryptedBalance } from "./eerc/helpers";
import { User } from "./eerc/user";

// depositFor (deposit-on-behalf) — BENZO PATCH (upstream v0.0.4), issue #105.
// The load-bearing primitive behind the CCTP onramp router (#108) and the private
// gift escrow (#117): an owner-authorized caller pulls an ERC20 from itself and
// credits ANOTHER registered user's encrypted balance, with no ZK proof.
//
// USDC-like token has 6 decimals; the eERC uses 2 decimals (matching the production
// tUSDC=6 / eERC=2 split) so the dust path (sub-unit remainder) is exercised.
const USDC_DECIMALS = 6;
const EERC_DECIMALS = 2;
const SCALE = 10n ** BigInt(USDC_DECIMALS - EERC_DECIMALS); // 10_000

describe("EncryptedERC - depositFor (deposit-on-behalf)", () => {
	let signers: SignerWithAddress[];
	let owner: SignerWithAddress;
	let depositor: SignerWithAddress; // stands in for the CCTP router / gift escrow (msg.sender)
	let registrar: Registrar;
	let encryptedERC: EncryptedERC;
	let usdc: SimpleERC20;
	let blacklisted: SimpleERC20;
	let users: User[];
	let recipient: User; // the registered user whose encrypted balance gets credited
	let unregistered: User; // never registered — used for the negative path
	let registrationCircuit: RegistrationCircuit;
	let chainId: bigint;

	// Registers `user` on `reg` (defaults to the module-level registrar). Fresh-stack
	// tests must pass their own registrar — the registration hash is per-registrar, and
	// re-registering on the wrong (already-populated) registrar hits UserAlreadyRegistered.
	const registerUser = async (user: User, reg: Registrar = registrar) => {
		const registrationHash = user.genRegistrationHash(chainId);
		const input = {
			SenderPrivateKey: user.formattedPrivateKey,
			SenderPublicKey: user.publicKey,
			SenderAddress: BigInt(user.signer.address),
			ChainID: chainId,
			RegistrationHash: registrationHash,
		};
		const proof = await registrationCircuit.generateProof(input);
		const calldata = await registrationCircuit.generateCalldata(proof);
		const tx = await reg.connect(user.signer).register({
			proofPoints: calldata.proofPoints,
			publicSignals: calldata.publicSignals,
		});
		await tx.wait();
	};

	// Recipient-encrypted amount PCT (uint256[7]) for the transaction-history entry.
	const pctFor = (value: bigint, publicKey: [bigint, bigint]) => {
		const { ciphertext, nonce, authKey } = processPoseidonEncryption(
			[value],
			publicKey,
		);
		return [...ciphertext, ...authKey, nonce];
	};

	const deployStack = async (isConverter: boolean) => {
		const {
			registrationVerifier,
			mintVerifier,
			withdrawVerifier,
			transferVerifier,
			burnVerifier,
		} = await deployVerifiers(owner);
		const babyJubJub = await deployLibrary(owner);

		const registrar_ = await new Registrar__factory(owner).deploy(
			registrationVerifier,
		);
		await registrar_.waitForDeployment();

		const eerc_ = await new EncryptedERC__factory({
			"contracts/eerc/libraries/BabyJubJub.sol:BabyJubJub": babyJubJub,
		})
			.connect(owner)
			.deploy({
				registrar: registrar_.target,
				isConverter,
				name: isConverter ? "" : "Standalone",
				symbol: isConverter ? "" : "STD",
				mintVerifier,
				withdrawVerifier,
				transferVerifier,
				burnVerifier,
				decimals: EERC_DECIMALS,
			});
		await eerc_.waitForDeployment();
		return { registrar: registrar_, eerc: eerc_ };
	};

	before(async () => {
		signers = await ethers.getSigners();
		owner = signers[0];
		depositor = signers[9];
		users = signers.map((signer) => new User(signer));
		recipient = users[1];
		unregistered = users[2];

		chainId = BigInt((await ethers.provider.getNetwork()).chainId);
		registrationCircuit = (await zkit.getCircuit(
			"RegistrationCircuit",
		)) as unknown as RegistrationCircuit;

		const stack = await deployStack(true);
		registrar = stack.registrar;
		encryptedERC = stack.eerc;

		// USDC-like (6dp) deposit token + a token that will be blacklisted.
		usdc = await new SimpleERC20__factory(owner).deploy(
			"USD Coin",
			"USDC",
			USDC_DECIMALS,
		);
		await usdc.waitForDeployment();
		blacklisted = await new SimpleERC20__factory(owner).deploy(
			"Bad Token",
			"BAD",
			USDC_DECIMALS,
		);
		await blacklisted.waitForDeployment();

		// The auditor identity (owner) and the recipient must be registered.
		await registerUser(users[0]);
		await registerUser(recipient);
		await (
			await encryptedERC.connect(owner).setAuditorPublicKey(owner.address)
		).wait();

		// Fund the depositor (the router/escrow holds the ERC20 it forwards).
		await (await usdc.connect(owner).mint(depositor.address, 1_000_000_000n)).wait();
		await (
			await encryptedERC.connect(owner).setTokenBlacklist(blacklisted.target, true)
		).wait();
	});

	describe("authorization", () => {
		it("reverts depositFor from a non-authorized caller", async () => {
			await usdc.connect(depositor).approve(encryptedERC.target, 1_000_000n);
			await expect(
				encryptedERC
					.connect(depositor)
					.depositFor(
						recipient.signer.address,
						1_000_000n,
						usdc.target,
						pctFor(100n, recipient.publicKey),
						"0x",
					),
			).to.be.revertedWithCustomError(encryptedERC, "NotAuthorizedDepositor");
		});

		it("only the owner can authorize a depositor", async () => {
			await expect(
				encryptedERC
					.connect(depositor)
					.setAuthorizedDepositor(depositor.address, true),
			).to.be.reverted;
		});

		it("rejects the zero address", async () => {
			await expect(
				encryptedERC.connect(owner).setAuthorizedDepositor(ethers.ZeroAddress, true),
			).to.be.revertedWithCustomError(encryptedERC, "ZeroAddress");
		});

		it("owner authorizes the depositor (emits AuthorizedDepositorSet)", async () => {
			await expect(
				encryptedERC.connect(owner).setAuthorizedDepositor(depositor.address, true),
			)
				.to.emit(encryptedERC, "AuthorizedDepositorSet")
				.withArgs(depositor.address, true);
			expect(await encryptedERC.authorizedDepositors(depositor.address)).to.be.true;
		});
	});

	describe("crediting the recipient", () => {
		let recipientBalance = 0n;

		it("credits `to` while pulling from the payer and returns dust to the payer", async () => {
			const rawAmount = 1_234_567n; // 6dp; scaled = 123, dust = 4567
			const scaledValue = rawAmount / SCALE;
			const dust = rawAmount % SCALE;

			await usdc.connect(depositor).approve(encryptedERC.target, rawAmount);
			const depositorBefore = await usdc.balanceOf(depositor.address);
			const recipientErc20Before = await usdc.balanceOf(recipient.signer.address);

			await expect(
				encryptedERC
					.connect(depositor)
					.depositFor(
						recipient.signer.address,
						rawAmount,
						usdc.target,
						pctFor(scaledValue, recipient.publicKey),
						"0x",
					),
			)
				.to.emit(encryptedERC, "Deposit")
				.withArgs(recipient.signer.address, rawAmount, dust, 1n);

			// Dust returns to the PAYER (msg.sender), never to `to`.
			expect(await usdc.balanceOf(depositor.address)).to.equal(
				depositorBefore - rawAmount + dust,
			);
			// The recipient never touches the ERC20.
			expect(await usdc.balanceOf(recipient.signer.address)).to.equal(
				recipientErc20Before,
			);

			// The recipient's ENCRYPTED balance decrypts to exactly the scaled value.
			const balance = await encryptedERC.getBalanceFromTokenAddress(
				recipient.signer.address,
				usdc.target,
			);
			const decrypted = await getDecryptedBalance(
				recipient.privateKey,
				balance.amountPCTs,
				balance.balancePCT,
				balance.eGCT,
			);
			expect(decrypted).to.equal(scaledValue);
			recipientBalance = decrypted;
		});

		it("accumulates across repeated depositFor calls", async () => {
			const rawAmount = 5_000_000n; // exact multiple of SCALE, no dust
			const scaledValue = rawAmount / SCALE;

			await usdc.connect(depositor).approve(encryptedERC.target, rawAmount);
			await (
				await encryptedERC
					.connect(depositor)
					.depositFor(
						recipient.signer.address,
						rawAmount,
						usdc.target,
						pctFor(scaledValue, recipient.publicKey),
						"0x",
					)
			).wait();

			const balance = await encryptedERC.getBalanceFromTokenAddress(
				recipient.signer.address,
				usdc.target,
			);
			const decrypted = await getDecryptedBalance(
				recipient.privateKey,
				balance.amountPCTs,
				balance.balancePCT,
				balance.eGCT,
			);
			expect(decrypted).to.equal(recipientBalance + scaledValue);
		});
	});

	describe("guards", () => {
		it("reverts when `to` is not registered", async () => {
			await usdc.connect(depositor).approve(encryptedERC.target, 1_000_000n);
			await expect(
				encryptedERC
					.connect(depositor)
					.depositFor(
						unregistered.signer.address,
						1_000_000n,
						usdc.target,
						pctFor(100n, unregistered.publicKey),
						"0x",
					),
			).to.be.revertedWithCustomError(encryptedERC, "UserNotRegistered");
		});

		it("reverts when the token is blacklisted", async () => {
			await blacklisted.connect(owner).mint(depositor.address, 1_000_000n);
			await blacklisted.connect(depositor).approve(encryptedERC.target, 1_000_000n);
			await expect(
				encryptedERC
					.connect(depositor)
					.depositFor(
						recipient.signer.address,
						1_000_000n,
						blacklisted.target,
						pctFor(100n, recipient.publicKey),
						"0x",
					),
			).to.be.revertedWithCustomError(encryptedERC, "TokenBlacklisted");
		});

		it("reverts before the auditor key is set", async () => {
			const fresh = await deployStack(true);
			await registerUser(recipient, fresh.registrar); // register on the fresh registrar
			await (
				await fresh.eerc.connect(owner).setAuthorizedDepositor(depositor.address, true)
			).wait();
			await usdc.connect(depositor).approve(fresh.eerc.target, 1_000_000n);
			// onlyIfAuditorSet reverts with a require-string (not a custom error) upstream.
			await expect(
				fresh.eerc
					.connect(depositor)
					.depositFor(
						recipient.signer.address,
						1_000_000n,
						usdc.target,
						pctFor(100n, recipient.publicKey),
						"0x",
					),
			).to.be.revertedWith("Auditor public key not set");
		});

		it("reverts in standalone mode (converter-only)", async () => {
			// Modifier order is [onlyIfAuditorSet, onlyForConverter, ...], so the auditor
			// must be set first to isolate the converter-only (InvalidOperation) revert.
			const standalone = await deployStack(false);
			await registerUser(users[0], standalone.registrar); // auditor identity
			await registerUser(recipient, standalone.registrar);
			await (
				await standalone.eerc.connect(owner).setAuditorPublicKey(owner.address)
			).wait();
			await (
				await standalone.eerc
					.connect(owner)
					.setAuthorizedDepositor(depositor.address, true)
			).wait();
			await usdc.connect(depositor).approve(standalone.eerc.target, 1_000_000n);
			await expect(
				standalone.eerc
					.connect(depositor)
					.depositFor(
						recipient.signer.address,
						1_000_000n,
						usdc.target,
						pctFor(100n, recipient.publicKey),
						"0x",
					),
			).to.be.revertedWithCustomError(standalone.eerc, "InvalidOperation");
		});
	});
});
