import { Base8, mulPointEscalar, subOrder } from "@zk-kit/baby-jubjub";
import { formatPrivKeyForBabyJub, genPrivKey } from "maci-crypto";
import { poseidon3 } from "poseidon-lite";
import fs from "node:fs/promises";
import path from "node:path";
import { ethers, network, zkit } from "hardhat";
import {
	processPoseidonDecryption,
	processPoseidonEncryption,
} from "../../src";
import { decryptPoint, encryptMessage } from "../../src/jub/jub";

const FUJI_CHAIN_ID = 43113n;
const DEPLOYMENTS_PATH = path.join(
	__dirname,
	"..",
	"..",
	"deployments",
	"fuji.json",
);

type BigNumberish = bigint | number | string;

type ProofPoints = {
	a: readonly [BigNumberish, BigNumberish];
	b: readonly [
		readonly [BigNumberish, BigNumberish],
		readonly [BigNumberish, BigNumberish],
	];
	c: readonly [BigNumberish, BigNumberish];
};

type CircuitCalldata = {
	proofPoints: ProofPoints;
	publicSignals: readonly BigNumberish[];
};

type ZkitCircuit<Input> = {
	generateProof(input: Input): Promise<unknown>;
	generateCalldata(proof: unknown): Promise<CircuitCalldata>;
};

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

type RuntimeUser = {
	decryptionKey: bigint;
	formattedPrivateKey: bigint;
	publicKey: [bigint, bigint];
	signer: Signer | ethers.Wallet;
};

type DeploymentEntry = string | { address?: unknown };

type Deployments = {
	contracts?: Record<string, DeploymentEntry | unknown>;
};

type BalanceView = {
	amountPCTs: readonly unknown[];
	balancePCT: bigint[];
	eGCT: [bigint[], bigint[]];
};

type RegistrationInput = {
	SenderPrivateKey: bigint;
	SenderPublicKey: [bigint, bigint];
	SenderAddress: bigint;
	ChainID: bigint;
	RegistrationHash: bigint;
};

type TransferInput = {
	ValueToTransfer: bigint;
	SenderPrivateKey: bigint;
	SenderPublicKey: [bigint, bigint];
	SenderBalance: bigint;
	SenderBalanceC1: bigint[];
	SenderBalanceC2: bigint[];
	SenderVTTC1: bigint[];
	SenderVTTC2: bigint[];
	ReceiverPublicKey: [bigint, bigint];
	ReceiverVTTC1: bigint[];
	ReceiverVTTC2: bigint[];
	ReceiverVTTRandom: bigint;
	ReceiverPCT: bigint[];
	ReceiverPCTAuthKey: bigint[];
	ReceiverPCTNonce: bigint;
	ReceiverPCTRandom: bigint;
	AuditorPublicKey: [bigint, bigint];
	AuditorPCT: bigint[];
	AuditorPCTAuthKey: bigint[];
	AuditorPCTNonce: bigint;
	AuditorPCTRandom: bigint;
};

const ADDRESS_ENV_KEYS = {
	eerc: ["PRIVATE_GIFT_EERC_ADDRESS", "EERC_ADDRESS", "ENCRYPTED_ERC_ADDRESS"],
	registrar: ["PRIVATE_GIFT_REGISTRAR_ADDRESS", "REGISTRAR_ADDRESS"],
	token: ["PRIVATE_GIFT_TOKEN_ADDRESS", "TUSDC_ADDRESS", "USDC_ADDRESS"],
};

const ADDRESS_DEPLOYMENT_KEYS = {
	eerc: ["EncryptedERC", "encryptedERC", "eerc"],
	registrar: ["Registrar", "registrar"],
	token: ["tUSDC", "tusdc", "testUSDC", "TestUSDC", "testUsdc", "USDC", "usdc"],
};

const parseBigInt = (value: string, name: string) => {
	try {
		return BigInt(value);
	} catch {
		throw new Error(`${name} must be a decimal or 0x-prefixed integer`);
	}
};

const readDeployments = async (): Promise<Deployments> => {
	try {
		const contents = await fs.readFile(DEPLOYMENTS_PATH, "utf8");
		return JSON.parse(contents) as Deployments;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
};

const deploymentAddress = (entry: DeploymentEntry | unknown): string | undefined => {
	if (typeof entry === "string") {
		return entry;
	}
	if (entry !== null && typeof entry === "object" && "address" in entry) {
		const address = (entry as { address?: unknown }).address;
		return typeof address === "string" ? address : undefined;
	}
	return undefined;
};

const resolveAddress = (
	label: keyof typeof ADDRESS_ENV_KEYS,
	deployments: Deployments,
) => {
	for (const envKey of ADDRESS_ENV_KEYS[label]) {
		const value = process.env[envKey];
		if (value) {
			return ethers.getAddress(value);
		}
	}

	for (const deploymentKey of ADDRESS_DEPLOYMENT_KEYS[label]) {
		const value = deploymentAddress(deployments.contracts?.[deploymentKey]);
		if (value) {
			return ethers.getAddress(value);
		}
	}

	throw new Error(
		`Missing ${label} address. Set one of ${ADDRESS_ENV_KEYS[label].join(
			", ",
		)} or add ${ADDRESS_DEPLOYMENT_KEYS[label].join(
			", ",
		)} to deployments/fuji.json.`,
	);
};

const createUser = (
	signer: Signer | ethers.Wallet,
	decryptionKey?: bigint,
): RuntimeUser => {
	const privateKey = decryptionKey ?? genPrivKey();
	const formattedPrivateKey = formatPrivKeyForBabyJub(privateKey) % subOrder;
	const publicKey = mulPointEscalar(Base8, formattedPrivateKey).map((value) =>
		BigInt(value),
	) as [bigint, bigint];

	return {
		decryptionKey: privateKey,
		formattedPrivateKey,
		publicKey,
		signer,
	};
};

const publicKeysEqual = (left: readonly BigNumberish[], right: readonly bigint[]) =>
	BigInt(left[0]) === right[0] && BigInt(left[1]) === right[1];

const registrationHash = (user: RuntimeUser, chainId: bigint) =>
	poseidon3([chainId, user.formattedPrivateKey, BigInt(user.signer.address)]);

const registerIfNeeded = async (
	registrar: Awaited<ReturnType<typeof ethers.getContractAt>>,
	user: RuntimeUser,
	chainId: bigint,
	label: string,
) => {
	const isRegistered = await registrar
		.getFunction("isUserRegistered")
		.staticCall(user.signer.address);

	if (isRegistered) {
		const onChainPublicKey = (await registrar
			.getFunction("getUserPublicKey")
			.staticCall(user.signer.address)) as readonly BigNumberish[];

		if (!publicKeysEqual(onChainPublicKey, user.publicKey)) {
			throw new Error(
				`${label} is already registered with a different eERC decryption key`,
			);
		}
		console.log(`${label} already registered: ${user.signer.address}`);
		return;
	}

	const circuit = (await zkit.getCircuit(
		"RegistrationCircuit",
	)) as ZkitCircuit<RegistrationInput>;
	const input = {
		SenderPrivateKey: user.formattedPrivateKey,
		SenderPublicKey: user.publicKey,
		SenderAddress: BigInt(user.signer.address),
		ChainID: chainId,
		RegistrationHash: registrationHash(user, chainId),
	};
	const proof = await circuit.generateProof(input);
	const calldata = await circuit.generateCalldata(proof);

	const tx = await registrar.connect(user.signer).getFunction("register")({
		proofPoints: calldata.proofPoints,
		publicSignals: calldata.publicSignals,
	});
	await tx.wait();
	console.log(`${label} registered: ${user.signer.address}`);
};

const readValue = (value: unknown, name: string, index: number) => {
	const record = value as Record<string, unknown> & ArrayLike<unknown>;
	return record[name] ?? record[index];
};

const readPoint = (value: unknown): bigint[] => {
	const x = readValue(value, "x", 0);
	const y = readValue(value, "y", 1);
	if (x === undefined || y === undefined) {
		throw new Error("Invalid point returned by EncryptedERC");
	}
	return [BigInt(x as BigNumberish), BigInt(y as BigNumberish)];
};

const readBalanceView = (balance: unknown): BalanceView => {
	const eGCT = readValue(balance, "eGCT", 0);
	const amountPCTs = readValue(balance, "amountPCTs", 2);
	const balancePCT = readValue(balance, "balancePCT", 3);
	if (eGCT === undefined || amountPCTs === undefined || balancePCT === undefined) {
		throw new Error("Invalid balanceOf return shape");
	}

	return {
		amountPCTs: amountPCTs as readonly unknown[],
		balancePCT: Array.from(balancePCT as readonly BigNumberish[], (value) =>
			BigInt(value),
		),
		eGCT: [
			readPoint(readValue(eGCT, "c1", 0)),
			readPoint(readValue(eGCT, "c2", 1)),
		],
	};
};

const readAmountPCT = (value: unknown): bigint[] => {
	const pct = readValue(value, "pct", 0);
	if (pct === undefined) {
		throw new Error("Invalid amountPCT return shape");
	}
	return Array.from(pct as readonly BigNumberish[], (part) => BigInt(part));
};

const decryptPCT = (privateKey: bigint, pct: bigint[], length = 1) => {
	const ciphertext = pct.slice(0, 4);
	const authKey = pct.slice(4, 6);
	const nonce = pct[6];

	return processPoseidonDecryption(
		ciphertext,
		authKey,
		nonce,
		privateKey,
		length,
	);
};

const decryptBalance = async (
	eerc: Awaited<ReturnType<typeof ethers.getContractAt>>,
	user: RuntimeUser,
	tokenId: bigint,
) => {
	const rawBalance = await eerc
		.getFunction("balanceOf")
		.staticCall(user.signer.address, tokenId);
	const balance = readBalanceView(rawBalance);
	let totalBalance = 0n;

	if (balance.balancePCT.some((value) => value !== 0n)) {
		const decryptedBalancePCT = decryptPCT(user.decryptionKey, balance.balancePCT);
		totalBalance += BigInt(decryptedBalancePCT[0]);
	}

	for (const amountPCT of balance.amountPCTs) {
		const pct = readAmountPCT(amountPCT);
		if (pct.some((value) => value !== 0n)) {
			const decryptedAmountPCT = decryptPCT(user.decryptionKey, pct);
			totalBalance += BigInt(decryptedAmountPCT[0]);
		}
	}

	const decryptedPoint = decryptPoint(
		user.decryptionKey,
		balance.eGCT[0],
		balance.eGCT[1],
	);
	if (totalBalance !== 0n) {
		const expectedPoint = mulPointEscalar(Base8, totalBalance).map((value) =>
			BigInt(value),
		);
		if (
			decryptedPoint[0] !== expectedPoint[0] ||
			decryptedPoint[1] !== expectedPoint[1]
		) {
			throw new Error(`Encrypted balance point mismatch for ${user.signer.address}`);
		}
	}

	return {
		encryptedBalance: [...balance.eGCT[0], ...balance.eGCT[1]],
		totalBalance,
	};
};

const privateTransfer = async (
	sender: RuntimeUser,
	senderBalance: bigint,
	receiverPublicKey: [bigint, bigint],
	transferAmount: bigint,
	senderEncryptedBalance: bigint[],
	auditorPublicKey: [bigint, bigint],
) => {
	const senderNewBalance = senderBalance - transferAmount;
	const { cipher: encryptedAmountSender } = encryptMessage(
		sender.publicKey,
		transferAmount,
	);
	const {
		cipher: encryptedAmountReceiver,
		random: encryptedAmountReceiverRandom,
	} = encryptMessage(receiverPublicKey, transferAmount);
	const {
		ciphertext: receiverCiphertext,
		nonce: receiverNonce,
		authKey: receiverAuthKey,
		encRandom: receiverEncRandom,
	} = processPoseidonEncryption([transferAmount], receiverPublicKey);
	const {
		ciphertext: auditorCiphertext,
		nonce: auditorNonce,
		authKey: auditorAuthKey,
		encRandom: auditorEncRandom,
	} = processPoseidonEncryption([transferAmount], auditorPublicKey);
	const {
		ciphertext: senderCiphertext,
		nonce: senderNonce,
		authKey: senderAuthKey,
	} = processPoseidonEncryption([senderNewBalance], sender.publicKey);

	const circuit = (await zkit.getCircuit(
		"TransferCircuit",
	)) as ZkitCircuit<TransferInput>;
	const input = {
		ValueToTransfer: transferAmount,
		SenderPrivateKey: sender.formattedPrivateKey,
		SenderPublicKey: sender.publicKey,
		SenderBalance: senderBalance,
		SenderBalanceC1: senderEncryptedBalance.slice(0, 2),
		SenderBalanceC2: senderEncryptedBalance.slice(2, 4),
		SenderVTTC1: encryptedAmountSender[0],
		SenderVTTC2: encryptedAmountSender[1],
		ReceiverPublicKey: receiverPublicKey,
		ReceiverVTTC1: encryptedAmountReceiver[0],
		ReceiverVTTC2: encryptedAmountReceiver[1],
		ReceiverVTTRandom: encryptedAmountReceiverRandom,
		ReceiverPCT: receiverCiphertext,
		ReceiverPCTAuthKey: receiverAuthKey,
		ReceiverPCTNonce: receiverNonce,
		ReceiverPCTRandom: receiverEncRandom,
		AuditorPublicKey: auditorPublicKey,
		AuditorPCT: auditorCiphertext,
		AuditorPCTAuthKey: auditorAuthKey,
		AuditorPCTNonce: auditorNonce,
		AuditorPCTRandom: auditorEncRandom,
	};
	const proof = await circuit.generateProof(input);
	const calldata = await circuit.generateCalldata(proof);

	return {
		proof: calldata,
		senderBalancePCT: [...senderCiphertext, ...senderAuthKey, senderNonce],
	};
};

const transferPrivate = async (
	eerc: Awaited<ReturnType<typeof ethers.getContractAt>>,
	from: RuntimeUser,
	to: RuntimeUser,
	tokenId: bigint,
	amount: bigint,
	auditorPublicKey: [bigint, bigint],
) => {
	const before = await decryptBalance(eerc, from, tokenId);
	if (before.totalBalance < amount) {
		throw new Error(
			`${from.signer.address} has encrypted balance ${before.totalBalance}; need ${amount}`,
		);
	}

	const { proof, senderBalancePCT } = await privateTransfer(
		from,
		before.totalBalance,
		to.publicKey,
		amount,
		before.encryptedBalance,
		auditorPublicKey,
	);
	const tx = await eerc
		.connect(from.signer)
		.getFunction(
			"transfer(address,uint256,((uint256[2],uint256[2][2],uint256[2]),uint256[32]),uint256[7])",
		)(to.signer.address, tokenId, proof, senderBalancePCT);
	await tx.wait();
};

const keyFromEnv = (name: string) => {
	const value = process.env[name];
	return value ? parseBigInt(value, name) : undefined;
};

const requireTwoSigners = async () => {
	const signers = await ethers.getSigners();
	if (signers.length < 2) {
		throw new Error(
			"private gift e2e requires PRIVATE_KEY and PRIVATE_KEY_2 so sender and claimant can both transact on Fuji",
		);
	}
	return [signers[0], signers[1]] as const;
};

const resolveTokenId = async (
	eerc: Awaited<ReturnType<typeof ethers.getContractAt>>,
	tokenAddress: string,
) => {
	const configuredTokenId = process.env.PRIVATE_GIFT_TOKEN_ID;
	if (configuredTokenId) {
		return parseBigInt(configuredTokenId, "PRIVATE_GIFT_TOKEN_ID");
	}

	const tokenId = await eerc.getFunction("tokenIds").staticCall(tokenAddress);
	if (tokenId === 0n) {
		throw new Error(
			`tUSDC token ${tokenAddress} is not registered in EncryptedERC; set PRIVATE_GIFT_TOKEN_ID if the deployment uses a nonstandard token id source`,
		);
	}
	return BigInt(tokenId);
};

const fundEphemeralGasFromClaimant = async (
	claimant: Signer,
	ephemeralAddress: string,
) => {
	const minimum = ethers.parseEther(
		process.env.PRIVATE_GIFT_MIN_EPHEMERAL_AVAX ?? "0.02",
	);
	const balance = await ethers.provider.getBalance(ephemeralAddress);
	if (balance >= minimum) {
		return;
	}

	const topUp = minimum - balance;
	console.warn(
		`Funding ephemeral address ${ephemeralAddress} with ${ethers.formatEther(
			topUp,
		)} AVAX from claimant ${claimant.address}; this is public metadata.`,
	);
	const tx = await claimant.sendTransaction({
		to: ephemeralAddress,
		value: topUp,
	});
	await tx.wait();
};

const serializeLinkPayload = (
	chainId: bigint,
	registrarAddress: string,
	eercAddress: string,
	tokenId: bigint,
	amount: bigint,
	ephemeral: RuntimeUser,
) => {
	const signer = ephemeral.signer as ethers.Wallet;
	const payload = {
		version: 1,
		chainId: chainId.toString(),
		registrarAddress,
		eercAddress,
		tokenId: tokenId.toString(),
		amount: amount.toString(),
		ephemeralAddress: signer.address,
		ephemeralPrivateKey: signer.privateKey,
		ephemeralDecryptionKey: ephemeral.decryptionKey.toString(),
		privacyLimits: [
			"Bearer secret: anyone with this payload can sweep the gift.",
			"No on-chain expiry or refund enforcement; sender retains this same ephemeral key and can sweep first.",
			"Ephemeral address and private transfer existence are public.",
			"Gas funding creates public metadata; claimant-funded gas avoids a sender-to-ephemeral funding link.",
		],
	};

	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
};

const main = async () => {
	const chainId = await ethers.provider
		.getNetwork()
		.then((providerNetwork) => providerNetwork.chainId);
	if (network.name !== "fuji" || chainId !== FUJI_CHAIN_ID) {
		throw new Error(
			`private gift e2e must target Fuji (43113); got ${network.name} (${chainId})`,
		);
	}

	const deployments = await readDeployments();
	const eercAddress = resolveAddress("eerc", deployments);
	const registrarAddress = resolveAddress("registrar", deployments);
	const tokenAddress = resolveAddress("token", deployments);
	const [senderSigner, claimantSigner] = await requireTwoSigners();
	const amount = parseBigInt(
		process.env.PRIVATE_GIFT_AMOUNT ?? "1000",
		"PRIVATE_GIFT_AMOUNT",
	);

	const registrar = await ethers.getContractAt("Registrar", registrarAddress);
	const eerc = await ethers.getContractAt("EncryptedERC", eercAddress);
	const tokenId = await resolveTokenId(eerc, tokenAddress);
	const auditorPublicKey = (await eerc
		.getFunction("auditorPublicKey")
		.staticCall()) as [bigint, bigint];

	const sender = createUser(
		senderSigner,
		keyFromEnv("PRIVATE_GIFT_SENDER_EERC_PRIVATE_KEY"),
	);
	const claimant = createUser(
		claimantSigner,
		keyFromEnv("PRIVATE_GIFT_CLAIMANT_EERC_PRIVATE_KEY"),
	);
	const ephemeralWallet = ethers.Wallet.createRandom().connect(ethers.provider);
	const ephemeral = createUser(ephemeralWallet);

	await registerIfNeeded(registrar, sender, chainId, "sender");
	await registerIfNeeded(registrar, ephemeral, chainId, "ephemeral");
	await registerIfNeeded(registrar, claimant, chainId, "claimant");

	const senderBefore = await decryptBalance(eerc, sender, tokenId);
	const claimantBefore = await decryptBalance(eerc, claimant, tokenId);
	console.log(`sender decrypted balance before: ${senderBefore.totalBalance}`);
	console.log(`claimant decrypted balance before: ${claimantBefore.totalBalance}`);

	await transferPrivate(eerc, sender, ephemeral, tokenId, amount, auditorPublicKey);
	const ephemeralFunded = await decryptBalance(eerc, ephemeral, tokenId);
	console.log(
		`ephemeral decrypted balance after gift funding: ${ephemeralFunded.totalBalance}`,
	);

	const serializedLink = serializeLinkPayload(
		chainId,
		registrarAddress,
		eercAddress,
		tokenId,
		amount,
		ephemeral,
	);
	console.log(`gift link payload (base64url JSON): ${serializedLink}`);

	await fundEphemeralGasFromClaimant(claimantSigner, ephemeral.signer.address);
	await transferPrivate(eerc, ephemeral, claimant, tokenId, amount, auditorPublicKey);

	const senderAfter = await decryptBalance(eerc, sender, tokenId);
	const ephemeralAfter = await decryptBalance(eerc, ephemeral, tokenId);
	const claimantAfter = await decryptBalance(eerc, claimant, tokenId);

	console.log(`sender decrypted balance after: ${senderAfter.totalBalance}`);
	console.log(`ephemeral decrypted balance after sweep: ${ephemeralAfter.totalBalance}`);
	console.log(`claimant decrypted balance after: ${claimantAfter.totalBalance}`);

	if (senderAfter.totalBalance !== senderBefore.totalBalance - amount) {
		throw new Error("sender decrypted balance did not decrease by gift amount");
	}
	if (ephemeralAfter.totalBalance !== 0n) {
		throw new Error("ephemeral decrypted balance was not swept to zero");
	}
	if (claimantAfter.totalBalance !== claimantBefore.totalBalance + amount) {
		throw new Error("claimant decrypted balance did not increase by gift amount");
	}
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
