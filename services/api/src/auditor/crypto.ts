import { randomBytes } from "node:crypto";
import {
	Base8,
	type Point,
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
import { decodeAbiParameters, encodeAbiParameters } from "viem";

export type AuditorKeypair = {
	privateKey: string;
	publicKey: [string, string];
};

export type AuditorPublicKey = [string, string];

export function createAuditorKeypair(privateKey = genPrivKey()): AuditorKeypair {
	const formattedPrivateKey = formatPrivKeyForBabyJub(privateKey) % subOrder;
	const publicKey = mulPointEscalar(Base8, formattedPrivateKey).map((value) =>
		BigInt(value).toString(),
	) as [string, string];

	return {
		privateKey: privateKey.toString(),
		publicKey,
	};
}

export function parseAuditorPrivateKey(value: string): bigint {
	const trimmed = value.trim();

	if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
		return BigInt(trimmed);
	}

	if (/^[0-9]+$/.test(trimmed)) {
		return BigInt(trimmed);
	}

	throw new Error("invalid_auditor_private_key");
}

export function publicKeyForPrivateKey(privateKey: string): AuditorPublicKey {
	return createAuditorKeypair(parseAuditorPrivateKey(privateKey)).publicKey;
}

export function decryptAuditorAmountPct(
	privateKey: string,
	amountPct: Buffer,
): bigint {
	const values = decodeAuditorPct(amountPct);
	const ciphertext = values.slice(0, 4);
	const authKey = values.slice(4, 6) as [bigint, bigint];
	const nonce = values[6];

	if (nonce === undefined) {
		throw new Error("invalid_auditor_pct");
	}

	const sharedKey = mulPointEscalar(
		authKey as Point<bigint>,
		formatPrivKeyForBabyJub(parseAuditorPrivateKey(privateKey)),
	);
	const [amount] = poseidonDecrypt(ciphertext, sharedKey, nonce, 1);

	if (amount === undefined) {
		throw new Error("invalid_auditor_pct");
	}

	return BigInt(amount);
}

export function encryptAuditorAmountPct(
	amount: bigint,
	publicKey: AuditorPublicKey,
): Buffer {
	const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`) + 1n;
	let encRandom = genRandomBabyJubValue();

	while (encRandom >= subOrder) {
		encRandom = genRandomBabyJubValue();
	}

	const authKey = mulPointEscalar(Base8, encRandom);
	const sharedKey = mulPointEscalar(
		publicKey.map((value) => BigInt(value)) as Point<bigint>,
		encRandom,
	);
	const ciphertext = poseidonEncrypt([amount], sharedKey, nonce);
	const pct = [
		...ciphertext,
		...authKey.map((value) => BigInt(value)),
		nonce,
	] as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
	const encoded = encodeAbiParameters([{ type: "uint256[7]" }], [pct]);

	return Buffer.from(encoded.slice(2), "hex");
}

function decodeAuditorPct(
	amountPct: Buffer,
): [bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
	const [decoded] = decodeAbiParameters(
		[{ type: "uint256[7]" }],
		`0x${amountPct.toString("hex")}`,
	);
	const values = Array.from(decoded, (value) => BigInt(value));
	const [first, second, third, fourth, fifth, sixth, seventh] = values;

	if (
		first === undefined ||
		second === undefined ||
		third === undefined ||
		fourth === undefined ||
		fifth === undefined ||
		sixth === undefined ||
		seventh === undefined
	) {
		throw new Error("invalid_auditor_pct");
	}

	return [first, second, third, fourth, fifth, sixth, seventh];
}
