import {
	Base8,
	type Point,
	mulPointEscalar,
	subOrder,
} from "@zk-kit/baby-jubjub";
import {
	formatPrivKeyForBabyJub,
	genPrivKey,
	poseidonDecrypt,
	sign,
	SNARK_FIELD_SIZE,
	verifySignature,
} from "maci-crypto";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { encryptAmountPct } from "../payroll/eerc.js";

export type AuditorKeypair = {
	privateKey: string;
	publicKey: [string, string];
};

export type AuditorPublicKey = [string, string];
export type AuditorManifestSignature = {
	R8: [string, string];
	S: string;
	algorithm: "poseidon-eddsa-babyjubjub";
	publicKey: AuditorPublicKey;
};

const manifestHashPattern = /^0x[0-9a-fA-F]{64}$/;

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
	const pct = encryptAmountPct(amount, [
		BigInt(publicKey[0]),
		BigInt(publicKey[1]),
	]);
	const encoded = encodeAbiParameters([{ type: "uint256[7]" }], [pct]);

	return Buffer.from(encoded.slice(2), "hex");
}

export function signAuditorManifestHash(
	privateKey: string,
	manifestHash: string,
): AuditorManifestSignature {
	const normalizedPrivateKey = parseAuditorPrivateKey(privateKey).toString();
	const signature = sign(
		normalizedPrivateKey,
		manifestHashSignatureMessage(manifestHash),
	);

	return {
		R8: [signature.R8[0].toString(), signature.R8[1].toString()],
		S: signature.S.toString(),
		algorithm: "poseidon-eddsa-babyjubjub",
		publicKey: publicKeyForPrivateKey(normalizedPrivateKey),
	};
}

export function verifyAuditorManifestSignature(
	manifestHash: string,
	signature: AuditorManifestSignature,
): boolean {
	if (signature.algorithm !== "poseidon-eddsa-babyjubjub") {
		return false;
	}

	try {
		return verifySignature(
			manifestHashSignatureMessage(manifestHash),
			{
				R8: [BigInt(signature.R8[0]), BigInt(signature.R8[1])],
				S: BigInt(signature.S),
			},
			signature.publicKey.map((value) => BigInt(value)) as Point<bigint>,
		);
	} catch {
		return false;
	}
}

export function decodeAuditorPct(
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

function manifestHashSignatureMessage(manifestHash: string): bigint {
	if (!manifestHashPattern.test(manifestHash)) {
		throw new Error("invalid_manifest_hash");
	}

	return BigInt(manifestHash) % SNARK_FIELD_SIZE;
}
