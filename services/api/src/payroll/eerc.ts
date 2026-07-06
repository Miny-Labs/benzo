import {
	Base8,
	Fr,
	type Point,
	addPoint,
	mulPointEscalar,
	subOrder,
} from "@zk-kit/baby-jubjub";
import {
	formatPrivKeyForBabyJub,
	genPrivKey,
	genRandomBabyJubValue,
	poseidonDecrypt,
	poseidonEncrypt,
} from "maci-crypto";
import { randomBytes } from "node:crypto";
import { poseidon3 } from "poseidon-lite";

const BASE_POINT_ORDER =
	2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export type ManagedEercAccount = {
	formattedPrivateKey: bigint;
	privateKey: bigint;
	publicKey: [bigint, bigint];
};

export type SealedManagedEercAccountV1 = {
	formattedPrivateKey: string;
	privateKey: string;
	publicKey: [string, string];
	version: 1;
};

export type EercBalance = {
	amountPCTs: Iterable<{ pct: Iterable<bigint> } | [Iterable<bigint>, bigint]>;
	balancePCT: Iterable<bigint>;
	eGCT: {
		c1: Iterable<bigint>;
		c2: Iterable<bigint>;
	};
};

export type BigintTuple5 = [bigint, bigint, bigint, bigint, bigint];
export type BigintTuple32 = [
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
];

export type Groth16Calldata<
	TPublicSignals extends readonly bigint[] = readonly bigint[],
> = {
	proofPoints: {
		a: [bigint, bigint];
		b: [[bigint, bigint], [bigint, bigint]];
		c: [bigint, bigint];
	};
	publicSignals: TPublicSignals;
};

export type RegistrationProofCalldata = Groth16Calldata<BigintTuple5>;
export type TransferProofCalldata = Groth16Calldata<BigintTuple32>;

export type TransferProofInput = {
	AuditorPCT: bigint[];
	AuditorPCTAuthKey: bigint[];
	AuditorPCTNonce: bigint;
	AuditorPCTRandom: bigint;
	AuditorPublicKey: [bigint, bigint];
	ReceiverPCT: bigint[];
	ReceiverPCTAuthKey: bigint[];
	ReceiverPCTNonce: bigint;
	ReceiverPCTRandom: bigint;
	ReceiverPublicKey: [bigint, bigint];
	ReceiverVTTC1: bigint[];
	ReceiverVTTC2: bigint[];
	ReceiverVTTRandom: bigint;
	SenderBalance: bigint;
	SenderBalanceC1: bigint[];
	SenderBalanceC2: bigint[];
	SenderPrivateKey: bigint;
	SenderPublicKey: [bigint, bigint];
	SenderVTTC1: bigint[];
	SenderVTTC2: bigint[];
	ValueToTransfer: bigint;
};

export type BuiltTransferProof = {
	input: TransferProofInput;
	senderBalancePCT: [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
};

export function createManagedEercAccount(
	privateKey = genPrivKey(),
): ManagedEercAccount {
	const formattedPrivateKey = formatPrivKeyForBabyJub(privateKey) % subOrder;
	const publicKey = mulPointEscalar(Base8, formattedPrivateKey).map((value) =>
		BigInt(value),
	) as [bigint, bigint];

	return {
		formattedPrivateKey,
		privateKey,
		publicKey,
	};
}

export function serializeManagedEercAccount(
	account: ManagedEercAccount,
): string {
	const stored: SealedManagedEercAccountV1 = {
		formattedPrivateKey: account.formattedPrivateKey.toString(),
		privateKey: account.privateKey.toString(),
		publicKey: [
			account.publicKey[0].toString(),
			account.publicKey[1].toString(),
		],
		version: 1,
	};

	return JSON.stringify(stored);
}

export function deserializeManagedEercAccount(
	stored: string,
): ManagedEercAccount {
	const parsed = JSON.parse(stored) as Partial<SealedManagedEercAccountV1>;

	if (
		parsed.version !== 1 ||
		typeof parsed.privateKey !== "string" ||
		typeof parsed.formattedPrivateKey !== "string" ||
		!Array.isArray(parsed.publicKey) ||
		parsed.publicKey.length !== 2 ||
		typeof parsed.publicKey[0] !== "string" ||
		typeof parsed.publicKey[1] !== "string"
	) {
		throw new Error("invalid_eerc_key_payload");
	}

	return {
		formattedPrivateKey: BigInt(parsed.formattedPrivateKey),
		privateKey: BigInt(parsed.privateKey),
		publicKey: [BigInt(parsed.publicKey[0]), BigInt(parsed.publicKey[1])],
	};
}

export function getRegistrationHash(
	account: ManagedEercAccount,
	signerAddress: string,
	chainId: bigint,
): bigint {
	return poseidon3([
		chainId,
		account.formattedPrivateKey,
		BigInt(signerAddress),
	]);
}

export function buildRegistrationProofInput(
	account: ManagedEercAccount,
	signerAddress: string,
	chainId: bigint,
) {
	return {
		ChainID: chainId,
		RegistrationHash: getRegistrationHash(account, signerAddress, chainId),
		SenderAddress: BigInt(signerAddress),
		SenderPrivateKey: account.formattedPrivateKey,
		SenderPublicKey: account.publicKey,
	};
}

export function buildTransferProofInput({
	auditorPublicKey,
	receiverPublicKey,
	sender,
	senderBalance,
	senderEncryptedBalance,
	transferAmount,
}: {
	auditorPublicKey: [bigint, bigint];
	receiverPublicKey: [bigint, bigint];
	sender: ManagedEercAccount;
	senderBalance: bigint;
	senderEncryptedBalance: bigint[];
	transferAmount: bigint;
}): BuiltTransferProof {
	if (senderBalance < transferAmount) {
		throw new Error("insufficient_treasury_balance");
	}

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

	return {
		input: {
			AuditorPCT: auditorCiphertext,
			AuditorPCTAuthKey: auditorAuthKey,
			AuditorPCTNonce: auditorNonce,
			AuditorPCTRandom: auditorEncRandom,
			AuditorPublicKey: auditorPublicKey,
			ReceiverPCT: receiverCiphertext,
			ReceiverPCTAuthKey: receiverAuthKey,
			ReceiverPCTNonce: receiverNonce,
			ReceiverPCTRandom: receiverEncRandom,
			ReceiverPublicKey: receiverPublicKey,
			ReceiverVTTC1: encryptedAmountReceiver[0],
			ReceiverVTTC2: encryptedAmountReceiver[1],
			ReceiverVTTRandom: encryptedAmountReceiverRandom,
			SenderBalance: senderBalance,
			SenderBalanceC1: senderEncryptedBalance.slice(0, 2),
			SenderBalanceC2: senderEncryptedBalance.slice(2, 4),
			SenderPrivateKey: sender.formattedPrivateKey,
			SenderPublicKey: sender.publicKey,
			SenderVTTC1: encryptedAmountSender[0],
			SenderVTTC2: encryptedAmountSender[1],
			ValueToTransfer: transferAmount,
		},
		senderBalancePCT: [
			...senderCiphertext,
			...senderAuthKey,
			senderNonce,
		] as [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
	};
}

export function getDecryptedBalance(
	privateKey: bigint,
	balance: EercBalance,
): bigint {
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

	const c1 = Array.from(balance.eGCT.c1);
	const c2 = Array.from(balance.eGCT.c2);
	const decryptedBalance = decryptPoint(privateKey, c1, c2);

	if (totalBalance !== 0n) {
		const expectedPoint = mulPointEscalar(Base8, totalBalance).map((value) =>
			BigInt(value),
		);
		if (
			decryptedBalance[0] !== expectedPoint[0] ||
			decryptedBalance[1] !== expectedPoint[1]
		) {
			throw new Error("decrypted_eerc_balance_mismatch");
		}
	}

	return totalBalance;
}

export function flattenEncryptedBalance(balance: EercBalance): bigint[] {
	return [
		...Array.from(balance.eGCT.c1),
		...Array.from(balance.eGCT.c2),
	];
}

export function normalizeEercBalance(value: unknown): EercBalance {
	const tuple = Array.isArray(value) ? value : null;
	const source =
		tuple ??
		(value && typeof value === "object"
			? (value as Record<string, unknown>)
			: null);

	if (!source) {
		throw new Error("invalid_eerc_balance");
	}

	const eGCT = readTupleOrObject(source, 0, "eGCT");
	const amountPCTs = readTupleOrObject(source, 2, "amountPCTs");
	const balancePCT = readTupleOrObject(source, 3, "balancePCT");
	const c1 = readTupleOrObject(eGCT, 0, "c1");
	const c2 = readTupleOrObject(eGCT, 1, "c2");

	return {
		amountPCTs: Array.isArray(amountPCTs)
			? amountPCTs.map((entry) => normalizeAmountPCT(entry))
			: [],
		balancePCT: normalizeBigintArray(balancePCT, "balancePCT"),
		eGCT: {
			c1: normalizePoint(c1, "eGCT.c1"),
			c2: normalizePoint(c2, "eGCT.c2"),
		},
	};
}

export function normalizePublicKey(value: unknown, label: string): [bigint, bigint] {
	const point = normalizeBigintArray(value, label);
	if (point.length !== 2) {
		throw new Error(`invalid_${label}`);
	}

	return [point[0]!, point[1]!];
}

function normalizeAmountPCT(
	value: unknown,
): { pct: [bigint, bigint, bigint, bigint, bigint, bigint, bigint] } {
	const pct = readTupleOrObject(value, 0, "pct");
	const normalized = normalizeBigintArray(pct, "amountPCT.pct");
	if (normalized.length !== 7) {
		throw new Error("invalid_amount_pct");
	}

	return {
		pct: normalized as [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
	};
}

function normalizePoint(value: unknown, label: string): [bigint, bigint] {
	const point = Array.isArray(value)
		? value
		: value && typeof value === "object"
			? [
					(value as Record<string, unknown>).x,
					(value as Record<string, unknown>).y,
				]
			: null;

	return normalizePublicKey(point, label);
}

function readTupleOrObject(
	source: unknown,
	index: number,
	key: string,
): unknown {
	if (Array.isArray(source)) {
		return source[index];
	}

	if (source && typeof source === "object") {
		return (source as Record<string, unknown>)[key];
	}

	return undefined;
}

function normalizeBigintArray(value: unknown, label: string): bigint[] {
	if (!Array.isArray(value)) {
		throw new Error(`invalid_${label}`);
	}

	return value.map((entry) => BigInt(entry as bigint | number | string));
}

// Ported from the vendored EncryptedERC TypeScript helpers in contracts/src.
function encryptMessage(
	publicKey: bigint[],
	message: bigint,
	random = genRandomBabyJubValue(),
): { cipher: [bigint[], bigint[]]; random: bigint } {
	let encRandom = random;
	while (encRandom >= BASE_POINT_ORDER) {
		encRandom = genRandomBabyJubValue();
	}
	const point = mulPointEscalar(Base8, message);

	return {
		cipher: encryptPoint(publicKey, point, encRandom),
		random: encRandom,
	};
}

function encryptPoint(
	publicKey: bigint[],
	point: bigint[],
	random = genRandomBabyJubValue(),
): [Point<bigint>, Point<bigint>] {
	const c1 = mulPointEscalar(Base8, random);
	const pky = mulPointEscalar(publicKey as Point<bigint>, random);
	const c2 = addPoint(point as Point<bigint>, pky);

	return [c1, c2];
}

function decryptPoint(
	privateKey: bigint,
	c1: bigint[],
	c2: bigint[],
): bigint[] {
	const privKey = formatPrivKeyForBabyJub(privateKey);
	const c1x = mulPointEscalar(c1 as Point<bigint>, privKey);
	const c1xInverse = [Fr.e(c1x[0] * -1n), c1x[1]];
	return addPoint(c2 as Point<bigint>, c1xInverse as Point<bigint>);
}

function randomNonce(): bigint {
	const bytes = randomBytes(16);
	return BigInt(`0x${bytes.toString("hex")}`) + 1n;
}

function processPoseidonEncryption(inputs: bigint[], publicKey: bigint[]) {
	const nonce = randomNonce();
	let encRandom = genRandomBabyJubValue();
	while (encRandom >= BASE_POINT_ORDER) {
		encRandom = genRandomBabyJubValue();
	}

	const poseidonEncryptionKey = mulPointEscalar(
		publicKey as Point<bigint>,
		encRandom,
	);
	const authKey = mulPointEscalar(Base8, encRandom);
	const ciphertext = poseidonEncrypt(inputs, poseidonEncryptionKey, nonce);

	return { authKey, ciphertext, encRandom, nonce, poseidonEncryptionKey };
}

function decryptPCT(
	privateKey: bigint,
	pct: Iterable<bigint>,
	length = 1,
): bigint[] {
	const values = Array.from(pct);
	const ciphertext = values.slice(0, 4);
	const authKey = values.slice(4, 6);
	const nonce = values[6]!;
	const sharedKey = mulPointEscalar(
		authKey as Point<bigint>,
		formatPrivKeyForBabyJub(privateKey),
	);

	return poseidonDecrypt(ciphertext, sharedKey, nonce, length).slice(0, length);
}

function amountPCTValues(
	amountPCT: { pct: Iterable<bigint> } | [Iterable<bigint>, bigint],
): bigint[] {
	return Array.from(Array.isArray(amountPCT) ? amountPCT[0] : amountPCT.pct);
}
