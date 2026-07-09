// Shared, hardhat-free eERC client crypto.
//
// The CCTP onramp / auto-deposit path (settleDeposit -> depositFor) and every
// "decrypt-and-assert exact balance" check depend on exactly two client-side
// primitives: building the Poseidon amount-PCT that rides along with a deposit,
// and decrypting an eERC balance back to a plaintext amount. Those live here as
// ONE implementation so the Fuji-fork integration tests (hardhat) and any other
// consumer share a single proving/crypto impl instead of re-deriving it inline.
//
// This module intentionally imports only pure crypto (./poseidon, ./jub) — no
// hardhat, no ethers — so it stays reusable outside the hardhat runtime.
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { decryptPoint } from "./jub/jub";
import {
	processPoseidonDecryption,
	processPoseidonEncryption,
} from "./poseidon/poseidon";

/** An eERC amount/balance PCT is always `[...ciphertext(4), ...authKey(2), nonce]`. */
export const AMOUNT_PCT_LENGTH = 7;

export type AmountPCT = [
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
	bigint,
];

/**
 * Build the Poseidon amount-PCT for `amount` encrypted to `publicKey`.
 *
 * Returns the canonical 7-word tuple the eERC contract expects
 * (`[...ciphertext, ...authKey, nonce]`) — the same shape `depositFor` and the
 * CCTP router's `settleDeposit` consume. Recompute this from the ACTUAL minted
 * amount (post-CCTP-fee), never the requested amount, or the decrypted balance
 * will disagree with the on-chain token transfer.
 */
export function buildAmountPCT(
	amount: bigint,
	publicKey: readonly bigint[],
): AmountPCT {
	const { ciphertext, nonce, authKey } = processPoseidonEncryption(
		[amount],
		publicKey as bigint[],
	);
	return [...ciphertext, ...authKey, nonce] as AmountPCT;
}

/**
 * Decrypt a single Poseidon PCT (`[...ciphertext(4), ...authKey(2), nonce]`)
 * back into its plaintext values.
 */
export function decryptPCT(
	privateKey: bigint,
	pct: readonly bigint[],
	length = 1,
): bigint[] {
	const ciphertext = pct.slice(0, 4);
	const authKey = pct.slice(4, 6);
	const nonce = pct[6];

	return processPoseidonDecryption(
		ciphertext,
		authKey,
		nonce,
		privateKey,
		length,
	).map((value) => BigInt(value));
}

export type EercBalanceCiphertext = {
	privateKey: bigint;
	/** Every amount PCT recorded for the token (each a 7-word tuple). */
	amountPCTs: ReadonlyArray<readonly bigint[]>;
	/** The rolling balance PCT (7-word tuple). */
	balancePCT: readonly bigint[];
	/** The ElGamal balance ciphertext `[c1, c2]` from the eERC contract. */
	eGCT: readonly [readonly bigint[], readonly bigint[]];
};

/**
 * Decrypt an eERC encrypted balance to its plaintext amount.
 *
 * Sums the balance PCT and every amount PCT, then cross-checks the total
 * against the ElGamal balance point so a mismatch surfaces as a thrown error
 * rather than a silently wrong number.
 */
export function decryptEercBalance({
	privateKey,
	amountPCTs,
	balancePCT,
	eGCT,
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

	const decryptedPoint = decryptPoint(
		privateKey,
		eGCT[0] as bigint[],
		eGCT[1] as bigint[],
	);

	if (total !== 0n) {
		const expectedPoint = mulPointEscalar(Base8, total);
		if (
			decryptedPoint[0] !== expectedPoint[0] ||
			decryptedPoint[1] !== expectedPoint[1]
		) {
			throw new Error(
				"eERC balance ciphertext does not match the summed PCT plaintext",
			);
		}
	}

	return total;
}
