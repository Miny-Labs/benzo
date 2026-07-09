import { randomBytes } from "node:crypto";
import { Base8, type Point, mulPointEscalar } from "@zk-kit/baby-jubjub";
import {
	formatPrivKeyForBabyJub,
	genRandomBabyJubValue,
	poseidonDecrypt,
	poseidonEncrypt,
} from "maci-crypto";

// Public BabyJubJub subgroup order (a curve constant, not an address). Used to
// rejection-sample encryption randomness, matching the @benzo/contracts patch.
const BASE_POINT_ORDER =
	2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export type AmountPCT = [
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
];

function randomNonce(): bigint {
	return BigInt(`0x${randomBytes(16).toString("hex")}`) + 1n;
}

/**
 * Build the Poseidon amount-PCT (`[...ciphertext(4), ...authKey(2), nonce]`) for
 * `amount` encrypted to `publicKey` — the tuple `settleDeposit`/`depositFor`
 * expect. Always encode the ACTUAL minted amount, never the requested one.
 */
export function buildAmountPCT(
	amount: bigint,
	publicKey: readonly bigint[],
): AmountPCT {
	const nonce = randomNonce();
	let encRandom = genRandomBabyJubValue();
	while (encRandom >= BASE_POINT_ORDER) {
		encRandom = genRandomBabyJubValue();
	}
	const encryptionKey = mulPointEscalar(publicKey as Point<bigint>, encRandom);
	const authKey = mulPointEscalar(Base8, encRandom);
	const ciphertext = poseidonEncrypt([amount], encryptionKey, nonce);
	return [...ciphertext, ...authKey, nonce] as AmountPCT;
}

// viem-native mirror of @benzo/contracts `eerc-client` (the hardhat-free eERC
// client crypto). It is duplicated here on purpose so the funded suites stay
// entirely off the hardhat/zkit toolchain — the decrypt path is a few lines of
// Poseidon/ElGamal over the same maci-crypto + baby-jubjub primitives, and the
// on-chain contract (not this code) is the source of truth the suites assert
// against.

/**
 * Decrypt a single Poseidon PCT (`[...ciphertext(4), ...authKey(2), nonce]`).
 */
export function decryptPCT(
	privateKey: bigint,
	pct: readonly bigint[],
	length = 1,
): bigint[] {
	const ciphertext = pct.slice(0, 4) as bigint[];
	const authKey = pct.slice(4, 6) as bigint[];
	const nonce = pct[6];
	const sharedKey = mulPointEscalar(
		authKey as [bigint, bigint],
		formatPrivKeyForBabyJub(privateKey),
	);
	return poseidonDecrypt(ciphertext, sharedKey, nonce, length)
		.slice(0, length)
		.map((value) => BigInt(value));
}

export type EercBalanceCiphertext = {
	privateKey: bigint;
	amountPCTs: ReadonlyArray<readonly bigint[]>;
	balancePCT: readonly bigint[];
};

/**
 * Sum the balance PCT and every amount PCT into the plaintext eERC balance.
 */
export function decryptEercBalance({
	privateKey,
	amountPCTs,
	balancePCT,
}: EercBalanceCiphertext): bigint {
	let total = 0n;
	if (balancePCT.some((word) => word !== 0n)) {
		total += decryptPCT(privateKey, balancePCT)[0];
	}
	for (const pct of amountPCTs) {
		if (pct.some((word) => word !== 0n)) {
			total += decryptPCT(privateKey, pct)[0];
		}
	}
	return total;
}

/** Derive the BabyJubJub public key for a formatted eERC private scalar. */
export function deriveEercPublicKey(
	formattedPrivateKey: bigint,
): [bigint, bigint] {
	const point = mulPointEscalar(Base8, formattedPrivateKey);
	return [BigInt(point[0]), BigInt(point[1])];
}

/** Shape of the eERC `getBalanceFromTokenAddress` view, as read via viem. */
export type EercBalanceRead = {
	amountPCTs: ReadonlyArray<{ pct: readonly bigint[] }>;
	balancePCT: readonly bigint[];
};

/** Decrypt a viem-read eERC balance struct into its plaintext amount. */
export function balanceFromRead(
	privateKey: bigint,
	read: EercBalanceRead,
): bigint {
	return decryptEercBalance({
		privateKey,
		amountPCTs: read.amountPCTs.map((entry) => entry.pct),
		balancePCT: read.balancePCT,
	});
}
