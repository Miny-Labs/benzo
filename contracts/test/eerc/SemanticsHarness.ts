import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
	Base8,
	Fr,
	type Point,
	addPoint,
	mulPointEscalar,
} from "@zk-kit/baby-jubjub";
import { expect } from "chai";
import { ethers, zkit } from "hardhat";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { poseidonDecrypt } from "maci-crypto";
import { poseidon3 } from "poseidon-lite";
import type { RegistrationCircuit } from "../../generated-types/zkit";
import { BASE_POINT_ORDER, BN254_SCALAR_FIELD } from "../../src/constants";
import { processPoseidonEncryption } from "../../src/poseidon/poseidon";
import type { AmountPCTStructOutput } from "../../typechain-types/contracts/eerc/EncryptedERC";
import type { Registrar } from "../../typechain-types/contracts/eerc/Registrar";
import type {
	EncryptedERC,
	SimpleERC20,
} from "../../typechain-types";
import {
	EncryptedERC__factory,
	Registrar__factory,
} from "../../typechain-types/factories/contracts/eerc";
import { SimpleERC20__factory } from "../../typechain-types/factories/contracts/eerc/tokens";
import {
	decryptPCT,
	deployLibrary,
	deployVerifiers,
	getDecryptedBalance,
	privateTransfer,
} from "./helpers";
import { User } from "./user";

const EERC_DECIMALS = 2;
const TUSDC_DECIMALS = 6;
const TUSDC_TO_EERC_SCALE = 10n ** BigInt(TUSDC_DECIMALS - EERC_DECIMALS);
// Domain size of SHA-256: 2^256 (the number of possible output values).
// Intentionally one more than the maximum output (2^256 - 1) — this is the
// correct modular base for the bias-rejection ("grind") sampling below.
const SHA_256_DOMAIN_SIZE =
	115792089237316195423570985008687907853269984665640564039457584007913129639936n;
const REGISTER_MESSAGE = (user: string) =>
	`eERC\nRegistering user with\n Address:${user.toLowerCase()}`;

type BlakeHash = {
	update(input: Buffer): BlakeHash;
	digest(): Buffer;
};
type CreateBlakeHash = (algorithm: "blake512") => BlakeHash;
type ProtocolUser = {
	signer: SignerWithAddress;
	formattedPrivateKey: bigint;
	publicKey: bigint[];
	genRegistrationHash(chainId: bigint): bigint;
};
type TxWithReceipt = {
	wait(): Promise<{ blockNumber: number } | null>;
};

const requireForTest = createRequire(__filename);
const createBlakeHash = requireForTest("blake-hash") as CreateBlakeHash;

const removeHexPrefix = (hex: string) => hex.replace(/^0x/, "");

const padString = (
	value: string,
	length: number,
	toLeft: boolean,
	padding = "0",
) => {
	const diff = length - value.length;
	if (diff <= 0) {
		return value;
	}

	const pad = padding.repeat(diff);
	return toLeft ? pad + value : value + pad;
};

const calculateByteLength = (length: number, byteSize = 8) => {
	const remainder = length % byteSize;
	return remainder
		? ((length - remainder) / byteSize) * byteSize + byteSize
		: length;
};

const sanitizeBytes = (value: string, byteSize = 8) =>
	padString(value, calculateByteLength(value.length, byteSize), true, "0");

const hashKeyWithIndex = (seed: string, index: number) => {
	const input = removeHexPrefix(seed) + sanitizeBytes(index.toString(16), 2);
	const digest = createHash("sha256")
		.update(Buffer.from(removeHexPrefix(input), "hex"))
		.digest("hex");

	return BigInt(`0x${digest}`);
};

const grindKey = (seed: string) => {
	const iterationLimit = 1_000;
	const maxAllowedValue =
		SHA_256_DOMAIN_SIZE - (SHA_256_DOMAIN_SIZE % BASE_POINT_ORDER);

	let i = 0;
	let key = hashKeyWithIndex(seed, i);
	i += 1;

	while (key >= maxAllowedValue) {
		key = hashKeyWithIndex(seed, i);
		i += 1;

		if (i > iterationLimit) {
			throw new Error("Could not find a valid eERC key");
		}
	}

	return (key % BASE_POINT_ORDER).toString(16);
};

const getPrivateKeyFromSignature = (signature: string) => {
	const fixed = removeHexPrefix(signature);
	const r = fixed.slice(0, 64);
	return grindKey(r);
};

const formatKeyForCurve = (key: string) => {
	// `key` is `grindKey`'s unpadded `.toString(16)`, so an odd number of hex
	// chars is expected and `Buffer.from(key, "hex")` drops the trailing nibble.
	// This is deliberate: the production @avalabs/eerc-sdk decodes the grind-key
	// hex the same unpadded way, so reproducing that exact (lossy) step is what
	// makes the restored key BYTE-IDENTICAL to a wallet's on-chain key. Do NOT
	// `padStart(64, "0")` here — padding would diverge from the SDK and silently
	// break the fidelity that the "restore keys" test exists to prove.
	let hash = createBlakeHash("blake512")
		.update(Buffer.from(key, "hex"))
		.digest()
		.slice(0, 32);

	const pruned = Buffer.from(hash);
	pruned[0] = (pruned[0] ?? 0) & 0xf8;
	pruned[31] = ((pruned[31] ?? 0) & 0x7f) | 0x40;
	hash = pruned;

	const littleEndian = BigInt(`0x${Buffer.from(hash).reverse().toString("hex")}`);
	return (littleEndian >> 3n) % BASE_POINT_ORDER;
};

class RestoredUser implements ProtocolUser {
	signer: SignerWithAddress;
	key: string;
	formattedPrivateKey: bigint;
	publicKey: bigint[];

	private constructor(
		signer: SignerWithAddress,
		key: string,
		formattedPrivateKey: bigint,
		publicKey: bigint[],
	) {
		this.signer = signer;
		this.key = key;
		this.formattedPrivateKey = formattedPrivateKey;
		this.publicKey = publicKey;
	}

	static async fromSignature(signer: SignerWithAddress) {
		const signature = await signer.signMessage(REGISTER_MESSAGE(signer.address));
		const key = getPrivateKeyFromSignature(signature);
		const formattedPrivateKey = formatKeyForCurve(key);
		const publicKey = mulPointEscalar(Base8, formattedPrivateKey).map((value) =>
			BigInt(value),
		);

		return new RestoredUser(signer, key, formattedPrivateKey, publicKey);
	}

	genRegistrationHash(chainId: bigint) {
		return poseidon3([
			chainId,
			this.formattedPrivateKey,
			BigInt(this.signer.address),
		]);
	}
}

const waitForBlock = async (tx: TxWithReceipt) => {
	const receipt = await tx.wait();
	if (!receipt) {
		throw new Error("Transaction was not mined");
	}

	return receipt.blockNumber;
};

const amountPCTFor = (amount: bigint, publicKey: bigint[]) => {
	const { ciphertext, authKey, nonce } = processPoseidonEncryption(
		[amount],
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

const decryptAuditorAmountOrNull = async (auditor: User, pct: bigint[]) => {
	try {
		const [amount] = await decryptPCT(auditor.privateKey, pct);
		return BigInt(amount);
	} catch {
		return null;
	}
};

const decryptPCTWithFormattedKey = (
	formattedPrivateKey: bigint,
	pct: bigint[],
) => {
	const ciphertext = pct.slice(0, 4);
	const authKey = pct.slice(4, 6);
	const nonce = pct[6];
	const sharedKey = mulPointEscalar(
		authKey as Point<bigint>,
		formattedPrivateKey,
	);

	return poseidonDecrypt(ciphertext, sharedKey, nonce, 1).slice(0, 1);
};

const decryptPointWithFormattedKey = (
	formattedPrivateKey: bigint,
	c1: bigint[],
	c2: bigint[],
) => {
	const c1x = mulPointEscalar(c1 as Point<bigint>, formattedPrivateKey);
	const c1xInverse = [Fr.e(c1x[0] * -1n), c1x[1]];
	return addPoint(c2 as Point<bigint>, c1xInverse as Point<bigint>);
};

const getDecryptedBalanceWithFormattedKey = (
	formattedPrivateKey: bigint,
	amountPCTs: AmountPCTStructOutput[],
	balancePCT: bigint[],
	encryptedBalance: bigint[][],
) => {
	let totalBalance = 0n;

	if (balancePCT.some((entry) => entry !== 0n)) {
		const decryptedBalancePCT = decryptPCTWithFormattedKey(
			formattedPrivateKey,
			balancePCT,
		);
		totalBalance += BigInt(decryptedBalancePCT[0]);
	}

	for (const [pct] of amountPCTs) {
		if (pct.some((entry) => entry !== 0n)) {
			const decryptedAmountPCT = decryptPCTWithFormattedKey(
				formattedPrivateKey,
				pct,
			);
			totalBalance += BigInt(decryptedAmountPCT[0]);
		}
	}

	const decryptedBalance = decryptPointWithFormattedKey(
		formattedPrivateKey,
		encryptedBalance[0],
		encryptedBalance[1],
	);

	if (totalBalance !== 0n) {
		const expectedPoint = mulPointEscalar(Base8, totalBalance);
		expect(decryptedBalance).to.deep.equal(expectedPoint);
	}

	return totalBalance;
};

describe("eERC v0.0.4 semantics harness", () => {
	let owner: SignerWithAddress;
	let registrar: Registrar;
	let encryptedERC: EncryptedERC;
	let tUSDC: SimpleERC20;
	let registrationCircuit: RegistrationCircuit;
	let auditorA: User;
	let auditorB: User;
	let sender: User;
	let receiver: User;
	let dustUser: User;
	let restoreSigner: SignerWithAddress;
	let restoreUser: RestoredUser;

	const registerUser = async (user: ProtocolUser) => {
		const chainId = await ethers.provider
			.getNetwork()
			.then((network) => network.chainId);
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
		await expect(registrationCircuit).to.verifyProof(proof);

		await registrar.connect(user.signer).register({
			proofPoints: calldata.proofPoints,
			publicSignals: calldata.publicSignals,
		});

		expect(await registrar.isUserRegistered(user.signer.address)).to.equal(true);
		expect(await registrar.getUserPublicKey(user.signer.address)).to.deep.equal(
			user.publicKey,
		);
		expect(await registrar.isRegistered(registrationHash)).to.equal(true);
	};

	before(async () => {
		const signers = await ethers.getSigners();
		owner = signers[0];
		auditorA = new User(signers[1]);
		auditorB = new User(signers[2]);
		sender = new User(signers[3]);
		receiver = new User(signers[4]);
		dustUser = new User(signers[5]);
		restoreSigner = signers[6];
		restoreUser = await RestoredUser.fromSignature(restoreSigner);

		const {
			registrationVerifier,
			mintVerifier,
			withdrawVerifier,
			transferVerifier,
			burnVerifier,
		} = await deployVerifiers(owner);
		const babyJubJub = await deployLibrary(owner);

		registrar = await new Registrar__factory(owner)
			.connect(owner)
			.deploy(registrationVerifier);
		await registrar.waitForDeployment();

		encryptedERC = await new EncryptedERC__factory({
			"contracts/eerc/libraries/BabyJubJub.sol:BabyJubJub": babyJubJub,
		})
			.connect(owner)
			.deploy({
				registrar: registrar.target,
				isConverter: true,
				name: "Benzo Private tUSDC",
				symbol: "btUSDC",
				mintVerifier,
				withdrawVerifier,
				transferVerifier,
				burnVerifier,
				decimals: EERC_DECIMALS,
			});
		await encryptedERC.waitForDeployment();

		tUSDC = await new SimpleERC20__factory(owner)
			.connect(owner)
			.deploy("Test USDC", "tUSDC", TUSDC_DECIMALS);
		await tUSDC.waitForDeployment();

		const circuit = await zkit.getCircuit("RegistrationCircuit");
		registrationCircuit = circuit as unknown as RegistrationCircuit;

		for (const user of [
			auditorA,
			auditorB,
			sender,
			receiver,
			dustUser,
			restoreUser,
		]) {
			await registerUser(user);
		}

		await encryptedERC
			.connect(owner)
			.setAuditorPublicKey(auditorA.signer.address);
	});

	it("empirically pins auditor key rotation to event-time encryption", async () => {
		const depositRawAmount = 10_000_000n;
		const depositPrivateAmount = depositRawAmount / TUSDC_TO_EERC_SCALE;
		const preRotationTransferAmount = 123n;
		const postRotationTransferAmount = 45n;

		await tUSDC.connect(owner).mint(sender.signer.address, depositRawAmount);
		await tUSDC
			.connect(sender.signer)
			.approve(encryptedERC.target, depositRawAmount);
		await encryptedERC
			.connect(sender.signer)
			["deposit(uint256,address,uint256[7])"](
				depositRawAmount,
				tUSDC.target,
				amountPCTFor(depositPrivateAmount, sender.publicKey),
			);

		const tokenId = await encryptedERC.tokenIds(tUSDC.target);
		const balanceBeforeTransfer = await encryptedERC.balanceOf(
			sender.signer.address,
			tokenId,
		);
		let senderBalance = await getDecryptedBalance(
			sender.privateKey,
			balanceBeforeTransfer.amountPCTs,
			balanceBeforeTransfer.balancePCT,
			balanceBeforeTransfer.eGCT,
		);

		const preRotationBalance = [
			...balanceBeforeTransfer.eGCT.c1,
			...balanceBeforeTransfer.eGCT.c2,
		];
		const preRotationProof = await privateTransfer(
			sender,
			senderBalance,
			receiver.publicKey,
			preRotationTransferAmount,
			preRotationBalance,
			auditorA.publicKey,
		);
		const preRotationBlock = await waitForBlock(
			await encryptedERC
				.connect(sender.signer)
				[
					"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])"
				](
					receiver.signer.address,
					tokenId,
					preRotationProof.proof,
					preRotationProof.senderBalancePCT,
				),
		);

		await encryptedERC
			.connect(owner)
			.setAuditorPublicKey(auditorB.signer.address);

		const balanceAfterRotation = await encryptedERC.balanceOf(
			sender.signer.address,
			tokenId,
		);
		senderBalance = await getDecryptedBalance(
			sender.privateKey,
			balanceAfterRotation.amountPCTs,
			balanceAfterRotation.balancePCT,
			balanceAfterRotation.eGCT,
		);
		const postRotationBalance = [
			...balanceAfterRotation.eGCT.c1,
			...balanceAfterRotation.eGCT.c2,
		];
		const postRotationProof = await privateTransfer(
			sender,
			senderBalance,
			receiver.publicKey,
			postRotationTransferAmount,
			postRotationBalance,
			auditorB.publicKey,
		);
		const postRotationBlock = await waitForBlock(
			await encryptedERC
				.connect(sender.signer)
				[
					"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])"
				](
					receiver.signer.address,
					tokenId,
					postRotationProof.proof,
					postRotationProof.senderBalancePCT,
				),
		);

		const [preRotationEvent] = await encryptedERC.queryFilter(
			encryptedERC.filters.PrivateTransfer,
			preRotationBlock,
			preRotationBlock,
		);
		const [postRotationEvent] = await encryptedERC.queryFilter(
			encryptedERC.filters.PrivateTransfer,
			postRotationBlock,
			postRotationBlock,
		);
		expect(preRotationEvent).to.not.equal(undefined);
		expect(postRotationEvent).to.not.equal(undefined);

		const preRotationAuditorPCT = [...preRotationEvent.args.auditorPCT];
		const postRotationAuditorPCT = [...postRotationEvent.args.auditorPCT];
		const [preRotationADecrypt] = await decryptPCT(
			auditorA.privateKey,
			preRotationAuditorPCT,
		);
		const preRotationBDecrypt = await decryptAuditorAmountOrNull(
			auditorB,
			preRotationAuditorPCT,
		);
		const postRotationADecrypt = await decryptAuditorAmountOrNull(
			auditorA,
			postRotationAuditorPCT,
		);
		const [postRotationBDecrypt] = await decryptPCT(
			auditorB.privateKey,
			postRotationAuditorPCT,
		);

		expect(preRotationEvent.args.auditorAddress).to.equal(
			auditorA.signer.address,
		);
		expect(postRotationEvent.args.auditorAddress).to.equal(
			auditorB.signer.address,
		);
		// The correct auditor recovers the exact amount; the wrong auditor's
		// decryption genuinely fails (returns null) — asserting null (rather than
		// merely "not equal to the amount") proves the isolation property instead
		// of passing trivially on any non-matching/garbage value.
		expect(BigInt(preRotationADecrypt)).to.equal(preRotationTransferAmount);
		expect(preRotationBDecrypt).to.be.null;
		expect(BigInt(postRotationBDecrypt)).to.equal(postRotationTransferAmount);
		expect(postRotationADecrypt).to.be.null;
	});

	it("empirically pins 6-decimal tUSDC deposits into 2-decimal private units", async () => {
		const depositCases = [
			{
				label: "exact two-decimal value",
				rawAmount: 10_120_000n,
				privateAmount: 1_012n,
				dust: 0n,
			},
			{
				label: "six-decimal value with dust",
				rawAmount: 10_123_456n,
				privateAmount: 1_012n,
				dust: 3_456n,
			},
			{
				label: "one private cent",
				rawAmount: 10_000n,
				privateAmount: 1n,
				dust: 0n,
			},
			{
				label: "below one private cent",
				rawAmount: 9_999n,
				privateAmount: 0n,
				dust: 9_999n,
			},
		];
		const mintTotal = depositCases.reduce(
			(total, testCase) => total + testCase.rawAmount,
			0n,
		);
		let expectedPrivateBalance = 0n;

		await tUSDC.connect(owner).mint(dustUser.signer.address, mintTotal);

		for (const testCase of depositCases) {
			expect(testCase.rawAmount / TUSDC_TO_EERC_SCALE).to.equal(
				testCase.privateAmount,
				testCase.label,
			);
			expect(testCase.rawAmount % TUSDC_TO_EERC_SCALE).to.equal(
				testCase.dust,
				testCase.label,
			);

			await tUSDC
				.connect(dustUser.signer)
				.approve(encryptedERC.target, testCase.rawAmount);
			const erc20BalanceBefore = await tUSDC.balanceOf(dustUser.signer.address);
			const blockNumber = await waitForBlock(
				await encryptedERC
					.connect(dustUser.signer)
					["deposit(uint256,address,uint256[7])"](
						testCase.rawAmount,
						tUSDC.target,
						amountPCTFor(testCase.privateAmount, dustUser.publicKey),
					),
			);
			const erc20BalanceAfter = await tUSDC.balanceOf(dustUser.signer.address);
			const [depositEvent] = await encryptedERC.queryFilter(
				encryptedERC.filters.Deposit,
				blockNumber,
				blockNumber,
			);
			expect(depositEvent).to.not.equal(undefined);
			expect(depositEvent.args.user).to.equal(dustUser.signer.address);
			expect(depositEvent.args.amount).to.equal(testCase.rawAmount);
			expect(depositEvent.args.dust).to.equal(testCase.dust);
			expect(erc20BalanceAfter).to.equal(
				erc20BalanceBefore - testCase.rawAmount + testCase.dust,
			);

			expectedPrivateBalance += testCase.privateAmount;
			const tokenId = await encryptedERC.tokenIds(tUSDC.target);
			const encryptedBalance = await encryptedERC.balanceOf(
				dustUser.signer.address,
				tokenId,
			);
			const decryptedBalance = await getDecryptedBalance(
				dustUser.privateKey,
				encryptedBalance.amountPCTs,
				encryptedBalance.balancePCT,
				encryptedBalance.eGCT,
			);
			expect(decryptedBalance).to.equal(expectedPrivateBalance);
		}
	});

	it("derives byte-identical restore keys and decrypts balance after restore", async () => {
		const freshContextA = await RestoredUser.fromSignature(restoreSigner);
		const freshContextB = await RestoredUser.fromSignature(restoreSigner);
		const depositRawAmount = 4_560_000n;
		const depositPrivateAmount = depositRawAmount / TUSDC_TO_EERC_SCALE;

		expect(freshContextA.key).to.equal(freshContextB.key);
		expect(freshContextA.formattedPrivateKey).to.equal(
			freshContextB.formattedPrivateKey,
		);
		expect(freshContextA.publicKey).to.deep.equal(freshContextB.publicKey);
		expect(
			ethers.getBytes(
				ethers.zeroPadValue(`0x${freshContextA.key.padStart(64, "0")}`, 32),
			),
		).to.deep.equal(
			ethers.getBytes(
				ethers.zeroPadValue(`0x${freshContextB.key.padStart(64, "0")}`, 32),
			),
		);
		expect(freshContextA.formattedPrivateKey).to.be.lessThan(BN254_SCALAR_FIELD);

		await tUSDC.connect(owner).mint(restoreSigner.address, depositRawAmount);
		await tUSDC
			.connect(restoreSigner)
			.approve(encryptedERC.target, depositRawAmount);
		await encryptedERC
			.connect(restoreSigner)
			["deposit(uint256,address,uint256[7])"](
				depositRawAmount,
				tUSDC.target,
				amountPCTFor(depositPrivateAmount, freshContextA.publicKey),
			);

		const tokenId = await encryptedERC.tokenIds(tUSDC.target);
		const encryptedBalance = await encryptedERC.balanceOf(
			restoreSigner.address,
			tokenId,
		);
		const balanceFromOriginalContext = getDecryptedBalanceWithFormattedKey(
			freshContextA.formattedPrivateKey,
			encryptedBalance.amountPCTs,
			encryptedBalance.balancePCT,
			encryptedBalance.eGCT,
		);
		const balanceFromRestoredContext = getDecryptedBalanceWithFormattedKey(
			freshContextB.formattedPrivateKey,
			encryptedBalance.amountPCTs,
			encryptedBalance.balancePCT,
			encryptedBalance.eGCT,
		);

		expect(balanceFromOriginalContext).to.equal(depositPrivateAmount);
		expect(balanceFromRestoredContext).to.equal(depositPrivateAmount);
	});
});
