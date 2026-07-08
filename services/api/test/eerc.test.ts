import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { describe, expect, it } from "vitest";
import {
	createAuditorKeypair,
	decryptAuditorAmountPct,
	encryptAuditorAmountPct,
} from "../src/auditor/crypto.js";
import {
	createManagedEercAccount,
	type EercBalance,
	encryptAmountPct,
	getDecryptedBalance,
} from "../src/payroll/eerc.js";

function pointFor(scalar: bigint): [bigint, bigint] {
	return mulPointEscalar(Base8, scalar).map((value) => BigInt(value)) as [
		bigint,
		bigint,
	];
}

// balancePCT decrypts to `amount`; the eGCT must decrypt to Base8 * amount for
// getDecryptedBalance to accept it, so this exercises the full round trip.
function balanceFor(amount: bigint): {
	account: ReturnType<typeof createManagedEercAccount>;
	balance: EercBalance;
} {
	const account = createManagedEercAccount(918_273n);
	return {
		account,
		balance: {
			amountPCTs: [],
			balancePCT: encryptAmountPct(amount, account.publicKey),
			eGCT: { c1: pointFor(0n), c2: pointFor(amount) },
		},
	};
}

describe("@benzo/api encryptAmountPct", () => {
	it("produces a 7-element PCT that decrypts back to the amount", () => {
		const account = createManagedEercAccount(451_237n);
		const amount = 4_200_000n;
		const pct = encryptAmountPct(amount, account.publicKey);

		expect(pct).toHaveLength(7);
		expect(pct.every((value) => typeof value === "bigint")).toBe(true);

		const balance: EercBalance = {
			amountPCTs: [],
			balancePCT: pct,
			eGCT: { c1: pointFor(0n), c2: pointFor(amount) },
		};
		expect(getDecryptedBalance(account.privateKey, balance)).toBe(amount);
	});

	it("encrypts a zero amount to a decryptable PCT", () => {
		const { account, balance } = balanceFor(0n);
		expect(getDecryptedBalance(account.privateKey, balance)).toBe(0n);
	});

	it("is randomized per call (fresh nonce/authKey) yet decrypts identically", () => {
		const account = createManagedEercAccount(778_899n);
		const amount = 1_000_000n;
		const first = encryptAmountPct(amount, account.publicKey);
		const second = encryptAmountPct(amount, account.publicKey);

		expect(first).not.toEqual(second);
		for (const pct of [first, second]) {
			expect(
				getDecryptedBalance(account.privateKey, {
					amountPCTs: [],
					balancePCT: pct,
					eGCT: { c1: pointFor(0n), c2: pointFor(amount) },
				}),
			).toBe(amount);
		}
	});

	it("keeps encryptAuditorAmountPct working via the shared helper", () => {
		const auditor = createAuditorKeypair(123_456_789n);
		const amount = 9_876_543n;
		const encoded = encryptAuditorAmountPct(amount, auditor.publicKey);

		expect(encoded).toBeInstanceOf(Buffer);
		expect(decryptAuditorAmountPct(auditor.privateKey, encoded)).toBe(amount);
	});
});
