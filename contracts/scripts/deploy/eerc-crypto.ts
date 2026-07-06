import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { Base8, mulPointEscalar, subOrder } from "@zk-kit/baby-jubjub";
import { ethers, zkit } from "hardhat";
import {
	formatPrivKeyForBabyJub,
	genPrivKey,
} from "maci-crypto";
import { poseidon3 } from "poseidon-lite";
import {
	processPoseidonEncryption,
	processPoseidonDecryption,
} from "../../src";
import { decryptPoint, encryptMessage } from "../../src/jub/jub";

type ZkitCircuit<TCalldata> = {
	generateProof: (input: Record<string, unknown>) => Promise<unknown>;
	generateCalldata: (proof: unknown) => Promise<TCalldata>;
};

type RegistrationCalldata = {
	proofPoints: {
		a: bigint[];
		b: bigint[][];
		c: bigint[];
	};
	publicSignals: bigint[];
};

export type EercAccount = {
	privateKey: bigint;
	formattedPrivateKey: bigint;
	publicKey: [bigint, bigint];
};

export type EercBalance = {
	amountPCTs: Iterable<{ pct: Iterable<bigint> } | [Iterable<bigint>, bigint]>;
	balancePCT: Iterable<bigint>;
	eGCT: {
		c1: Iterable<bigint>;
		c2: Iterable<bigint>;
	};
};

export const createEercAccount = (privateKey = genPrivKey()): EercAccount => {
	const formattedPrivateKey = formatPrivKeyForBabyJub(privateKey) % subOrder;
	const publicKey = mulPointEscalar(Base8, formattedPrivateKey).map((value) =>
		BigInt(value),
	) as [bigint, bigint];

	return {
		privateKey,
		formattedPrivateKey,
		publicKey,
	};
};

export const serializeEercAccount = (account: EercAccount) => ({
	privateKey: account.privateKey.toString(),
	formattedPrivateKey: account.formattedPrivateKey.toString(),
	publicKey: account.publicKey.map((value) => value.toString()),
});

export const deserializeEercAccount = (stored: {
	privateKey: string;
}): EercAccount => createEercAccount(BigInt(stored.privateKey));

export const getRegistrationHash = (
	account: EercAccount,
	signerAddress: string,
	chainId: bigint,
) =>
	poseidon3([
		chainId,
		account.formattedPrivateKey,
		BigInt(signerAddress),
	]);

export const generateRegistrationCalldata = async (
	account: EercAccount,
	signerAddress: string,
	chainId: bigint,
) => {
	const circuit = (await zkit.getCircuit(
		"RegistrationCircuit",
	)) as unknown as ZkitCircuit<RegistrationCalldata>;
	const registrationHash = getRegistrationHash(account, signerAddress, chainId);

	const proof = await circuit.generateProof({
		SenderPrivateKey: account.formattedPrivateKey,
		SenderPublicKey: account.publicKey,
		SenderAddress: BigInt(signerAddress),
		ChainID: chainId,
		RegistrationHash: registrationHash,
	});

	return circuit.generateCalldata(proof);
};

export const registerEercAccount = async (
	registrar: {
		connect: (signer: SignerWithAddress) => {
			register: (proof: RegistrationCalldata) => Promise<{ wait: () => Promise<unknown> }>;
		};
		getUserPublicKey: (address: string) => Promise<Iterable<bigint>>;
		isUserRegistered: (address: string) => Promise<boolean>;
	},
	signer: SignerWithAddress,
	account: EercAccount,
) => {
	if (await registrar.isUserRegistered(signer.address)) {
		const publicKey = Array.from(await registrar.getUserPublicKey(signer.address));
		if (
			publicKey[0] !== account.publicKey[0] ||
			publicKey[1] !== account.publicKey[1]
		) {
			throw new Error(`${signer.address} is already registered with another eERC key`);
		}

		return undefined;
	}

	const chainId = (await ethers.provider.getNetwork()).chainId;
	const calldata = await generateRegistrationCalldata(
		account,
		signer.address,
		chainId,
	);
	const tx = await registrar.connect(signer).register(calldata);
	const receipt = await tx.wait();

	return { receipt, transactionHash: "hash" in tx ? tx.hash : undefined };
};

export const encryptAmountPCT = (
	amount: bigint,
	publicKey: [bigint, bigint],
) => {
	const { ciphertext, nonce, authKey } = processPoseidonEncryption(
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

const amountPCTValues = (
	amountPCT: { pct: Iterable<bigint> } | [Iterable<bigint>, bigint],
) => Array.from(Array.isArray(amountPCT) ? amountPCT[0] : amountPCT.pct);

const decryptPCT = (
	privateKey: bigint,
	pct: Iterable<bigint>,
	length = 1,
) => {
	const values = Array.from(pct);
	const ciphertext = values.slice(0, 4);
	const authKey = values.slice(4, 6) as [bigint, bigint];
	const nonce = values[6];

	return processPoseidonDecryption(
		ciphertext,
		authKey,
		nonce,
		privateKey,
		length,
	);
};

export const getDecryptedBalance = (privateKey: bigint, balance: EercBalance) => {
	let totalBalance = 0n;
	const balancePCT = Array.from(balance.balancePCT);

	if (balancePCT.some((value) => value !== 0n)) {
		totalBalance += BigInt(decryptPCT(privateKey, balancePCT)[0]);
	}

	for (const amountPCT of balance.amountPCTs) {
		const pct = amountPCTValues(amountPCT);
		if (pct.some((value) => value !== 0n)) {
			totalBalance += BigInt(decryptPCT(privateKey, pct)[0]);
		}
	}

	const eGCTC1 = Array.from(balance.eGCT.c1);
	const eGCTC2 = Array.from(balance.eGCT.c2);
	const decryptedBalance = decryptPoint(privateKey, eGCTC1, eGCTC2);

	if (totalBalance !== 0n) {
		const expectedPoint = mulPointEscalar(Base8, totalBalance).map((value) =>
			BigInt(value),
		);
		if (
			decryptedBalance[0] !== expectedPoint[0] ||
			decryptedBalance[1] !== expectedPoint[1]
		) {
			throw new Error("Decrypted eERC balance does not match balance history");
		}
	}

	return totalBalance;
};

export const flattenEncryptedBalance = (balance: EercBalance) => [
	...Array.from(balance.eGCT.c1),
	...Array.from(balance.eGCT.c2),
];

type ProofCalldata = {
	proofPoints: {
		a: bigint[];
		b: bigint[][];
		c: bigint[];
	};
	publicSignals: bigint[];
};

export const generatePrivateTransfer = async ({
	auditorPublicKey,
	receiverPublicKey,
	sender,
	senderBalance,
	senderEncryptedBalance,
	transferAmount,
}: {
	auditorPublicKey: [bigint, bigint];
	receiverPublicKey: [bigint, bigint];
	sender: EercAccount;
	senderBalance: bigint;
	senderEncryptedBalance: bigint[];
	transferAmount: bigint;
}) => {
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
	)) as unknown as ZkitCircuit<ProofCalldata>;
	const proof = await circuit.generateProof({
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
	});

	return {
		proof: await circuit.generateCalldata(proof),
		senderBalancePCT: [
			...senderCiphertext,
			...senderAuthKey,
			senderNonce,
		] as [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
	};
};

export const generateWithdraw = async ({
	amount,
	auditorPublicKey,
	user,
	userBalance,
	userEncryptedBalance,
}: {
	amount: bigint;
	auditorPublicKey: [bigint, bigint];
	user: EercAccount;
	userBalance: bigint;
	userEncryptedBalance: bigint[];
}) => {
	const newBalance = userBalance - amount;
	const {
		ciphertext: userCiphertext,
		nonce: userNonce,
		authKey: userAuthKey,
	} = processPoseidonEncryption([newBalance], user.publicKey);
	const {
		ciphertext: auditorCiphertext,
		nonce: auditorNonce,
		encRandom: auditorEncRandom,
		authKey: auditorAuthKey,
	} = processPoseidonEncryption([amount], auditorPublicKey);

	const circuit = (await zkit.getCircuit(
		"WithdrawCircuit",
	)) as unknown as ZkitCircuit<ProofCalldata>;
	const proof = await circuit.generateProof({
		ValueToWithdraw: amount,
		SenderPrivateKey: user.formattedPrivateKey,
		SenderPublicKey: user.publicKey,
		SenderBalance: userBalance,
		SenderBalanceC1: userEncryptedBalance.slice(0, 2),
		SenderBalanceC2: userEncryptedBalance.slice(2, 4),
		AuditorPublicKey: auditorPublicKey,
		AuditorPCT: auditorCiphertext,
		AuditorPCTAuthKey: auditorAuthKey,
		AuditorPCTNonce: auditorNonce,
		AuditorPCTRandom: auditorEncRandom,
	});

	return {
		proof: await circuit.generateCalldata(proof),
		userBalancePCT: [
			...userCiphertext,
			...userAuthKey,
			userNonce,
		] as [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
	};
};
