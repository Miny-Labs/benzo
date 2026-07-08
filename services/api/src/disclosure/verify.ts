import { Base8, type Point, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { and, eq } from "drizzle-orm";
import { poseidonDecrypt } from "maci-crypto";
import { getAddress, isAddress } from "viem";
import { decodeAuditorPct } from "../auditor/crypto.js";
import { findKeyForEvent, loadAuditorKeys } from "../auditor/service.js";
import type { Database } from "../db/client.js";
import { events } from "../db/schema.js";

// Tier A — trustless self-disclosure of a single encrypted transfer.
//
// HONEST SCOPE: eERC v0.0.4 ships no disclosure circuit, so this is
// reveal-and-verify, NOT a zero-knowledge disclosure proof. The payer (or payee
// who was handed the reveal) proves ONE payment's amount to a verifier using
// only the auditor PCT already on-chain plus the ephemeral `encRandom` the
// sender kept from proof generation. It uses no auditor private key and runs no
// SNARK. Proof-of-exact-balance / balance-range disclosure is out of scope — it
// would require a new circuit (see the route module for the follow-up note).
//
// The eERC auditor PCT for a transfer is `poseidonEncrypt([amount], sharedKey,
// nonce)` where `sharedKey = auditorPublicKey * encRandom` and the PCT also
// carries `authKey = Base8 * encRandom`. Given `encRandom`, a verifier can:
//   1. recompute `authKey` and assert it matches the on-chain PCT — this binds
//      the reveal to THIS event and is the privacy gate (a reveal for one
//      transfer never matches another transfer's authKey), and
//   2. recompute `sharedKey` and poseidon-decrypt the ciphertext to recover the
//      amount, asserting it equals the claimed amount.

export type AuditorPublicKeyTuple = [bigint, bigint];

export type RecoverDisclosedAmountInput = {
	amountPct: Buffer;
	auditorPublicKey: AuditorPublicKeyTuple;
	encRandom: bigint;
};

export type RecoverDisclosedAmountResult =
	| { ok: true; amount: bigint }
	| { ok: false; reason: "auth_key_mismatch" | "decrypt_failed" | "invalid_auditor_pct" };

// Pure crypto core: no DB, no auditor key. Recomputes the ephemeral authKey from
// `encRandom`, rejects a reveal that does not belong to this PCT, then decrypts.
export function recoverDisclosedAmount(
	input: RecoverDisclosedAmountInput,
): RecoverDisclosedAmountResult {
	let values: ReturnType<typeof decodeAuditorPct>;

	try {
		values = decodeAuditorPct(input.amountPct);
	} catch {
		return { ok: false, reason: "invalid_auditor_pct" };
	}

	const ciphertext = values.slice(0, 4);
	const storedAuthKey = values.slice(4, 6) as [bigint, bigint];
	const nonce = values[6];

	// `encRandom` is used raw (not `formatPrivKeyForBabyJub`), matching how the
	// sender derived `authKey = Base8 * encRandom` during proof generation.
	const computedAuthKey = mulPointEscalar(Base8, input.encRandom);

	if (
		BigInt(computedAuthKey[0]) !== storedAuthKey[0] ||
		BigInt(computedAuthKey[1]) !== storedAuthKey[1]
	) {
		return { ok: false, reason: "auth_key_mismatch" };
	}

	const sharedKey = mulPointEscalar(
		input.auditorPublicKey as Point<bigint>,
		input.encRandom,
	);

	try {
		const [amount] = poseidonDecrypt(ciphertext, sharedKey, nonce, 1);

		if (amount === undefined) {
			return { ok: false, reason: "decrypt_failed" };
		}

		return { ok: true, amount: BigInt(amount) };
	} catch {
		return { ok: false, reason: "decrypt_failed" };
	}
}

export type DisclosureReveal = {
	claimedAmount: bigint;
	encRandom: bigint;
	from?: string;
	to?: string;
};

export type DisclosureFailureReason =
	| "event_not_found"
	| "event_not_encrypted"
	| "auditor_key_missing"
	| "auth_key_mismatch"
	| "decrypt_failed"
	| "invalid_auditor_pct"
	| "amount_mismatch"
	| "from_mismatch"
	| "to_mismatch";

export type DisclosureVerification =
	| {
			verified: true;
			amount: string;
			auditorKeyId: string;
			from: string | null;
			logIndex: number;
			to: string | null;
			txHash: string;
	  }
	| { verified: false; reason: DisclosureFailureReason };

export type VerifyDisclosureInput = {
	logIndex: number;
	reveal: DisclosureReveal;
	txHash: string;
};

// DB-aware Tier A verification: resolves the on-chain event and the auditor
// public key that covered it, recovers the amount, and binds the claimed
// counterparties to the event's from/to.
export async function verifyDisclosure(
	db: Database,
	input: VerifyDisclosureInput,
): Promise<DisclosureVerification> {
	const [row] = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.txHash, input.txHash.toLowerCase()),
				eq(events.logIndex, input.logIndex),
			),
		)
		.limit(1);

	if (!row) {
		return { verified: false, reason: "event_not_found" };
	}

	if (!row.amountPct) {
		return { verified: false, reason: "event_not_encrypted" };
	}

	const keys = await loadAuditorKeys(db);
	const key = findKeyForEvent(keys, row);

	if (!key) {
		return { verified: false, reason: "auditor_key_missing" };
	}

	const recovered = recoverDisclosedAmount({
		amountPct: row.amountPct,
		auditorPublicKey: [BigInt(key.publicKeyX), BigInt(key.publicKeyY)],
		encRandom: input.reveal.encRandom,
	});

	if (!recovered.ok) {
		return { verified: false, reason: recovered.reason };
	}

	if (recovered.amount !== input.reveal.claimedAmount) {
		return { verified: false, reason: "amount_mismatch" };
	}

	if (
		input.reveal.from !== undefined &&
		normalizeAddress(input.reveal.from) !== row.fromAddr
	) {
		return { verified: false, reason: "from_mismatch" };
	}

	if (
		input.reveal.to !== undefined &&
		normalizeAddress(input.reveal.to) !== row.toAddr
	) {
		return { verified: false, reason: "to_mismatch" };
	}

	return {
		verified: true,
		amount: recovered.amount.toString(),
		auditorKeyId: key.id,
		from: row.fromAddr,
		logIndex: row.logIndex,
		to: row.toAddr,
		txHash: row.txHash,
	};
}

function normalizeAddress(address: string): string | null {
	if (!isAddress(address, { strict: false })) {
		return null;
	}

	return getAddress(address).toLowerCase();
}
