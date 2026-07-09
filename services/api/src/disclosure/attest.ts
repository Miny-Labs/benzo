import { and, eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptAuditorAmountPct } from "../auditor/crypto.js";
import { findKeyForEvent, loadAuditorKeys } from "../auditor/service.js";
import type { ApiConfig } from "../config.js";
import { unsealString } from "../crypto/seal.js";
import type { Database } from "../db/client.js";
import { auditLog, events } from "../db/schema.js";
import { normalizeAddress } from "./address.js";

// Tier B — server-side, auditor-signed proof-of-payment packet.
//
// The server unseals the auditor private key, decrypts the amount for a single
// encrypted transfer, and returns a compact ECDSA-signed attestation. Unlike
// Tier A this trusts Benzo's attestation signer (published via
// GET /disclosure/attestation-key), but it needs no `encRandom` from the wallet
// and works for the payee too. The signature is EIP-191 over the canonical
// message so any verifier can `recoverMessageAddress` and match the published
// attestation address.

export const PROOF_OF_PAYMENT_VERSION = "benzo-proof-of-payment-1" as const;

export type ProofOfPaymentPacket = {
	amount: string;
	attestationAddress: string;
	auditorKeyId: string;
	chainId: number;
	// The EncryptedERC contract that emitted the event.
	contract: string;
	// The underlying ERC-20 (USDC vs EURC) is NOT recoverable from a converter
	// PCT, so `token` is always null rather than a misleading copy of `contract`.
	token: string | null;
	from: string | null;
	logIndex: number;
	signature: Hex;
	signedAt: string;
	to: string | null;
	txHash: string;
	version: typeof PROOF_OF_PAYMENT_VERSION;
};

export type ProofOfPaymentFailureReason =
	| "attestation_key_not_configured"
	| "event_not_found"
	| "event_not_encrypted"
	| "auditor_key_missing"
	| "not_a_party";

export type ProofOfPaymentResult =
	| { ok: true; packet: ProofOfPaymentPacket }
	| { ok: false; reason: ProofOfPaymentFailureReason };

export type BuildProofOfPaymentInput = {
	// The authenticated caller. Tier B is gated to the transfer's payer/payee.
	requesterAddress: string;
	logIndex: number;
	txHash: string;
};

export function attestationSignerAddress(config: ApiConfig): string | null {
	if (!config.auditorAttestationPrivateKey) {
		return null;
	}

	return privateKeyToAccount(
		config.auditorAttestationPrivateKey as Hex,
	).address;
}

// The signed message binds every field of the packet so the signature cannot be
// replayed over an altered attestation. Deterministic key order keeps the hash
// stable between signer and verifier.
export function proofOfPaymentMessage(
	packet: Omit<ProofOfPaymentPacket, "signature">,
): string {
	return JSON.stringify({
		amount: packet.amount,
		attestationAddress: packet.attestationAddress,
		auditorKeyId: packet.auditorKeyId,
		chainId: packet.chainId,
		contract: packet.contract,
		from: packet.from,
		logIndex: packet.logIndex,
		signedAt: packet.signedAt,
		to: packet.to,
		token: packet.token,
		txHash: packet.txHash,
		version: packet.version,
	});
}

export async function buildProofOfPayment(
	db: Database,
	config: ApiConfig,
	input: BuildProofOfPaymentInput,
): Promise<ProofOfPaymentResult> {
	if (!config.auditorAttestationPrivateKey) {
		return { ok: false, reason: "attestation_key_not_configured" };
	}

	const requester = normalizeAddress(input.requesterAddress);
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
		return { ok: false, reason: "event_not_found" };
	}

	if (!row.amountPct) {
		return { ok: false, reason: "event_not_encrypted" };
	}

	if (requester === null || (requester !== row.fromAddr && requester !== row.toAddr)) {
		return { ok: false, reason: "not_a_party" };
	}

	const keys = await loadAuditorKeys(db);
	const key = findKeyForEvent(keys, row);

	if (!key) {
		return { ok: false, reason: "auditor_key_missing" };
	}

	const auditorPrivateKey = unsealString(config.appMasterKey, key.sealedKey);
	const amount = decryptAuditorAmountPct(auditorPrivateKey, row.amountPct);
	const account = privateKeyToAccount(
		config.auditorAttestationPrivateKey as Hex,
	);
	const unsigned: Omit<ProofOfPaymentPacket, "signature"> = {
		amount: amount.toString(),
		attestationAddress: account.address,
		auditorKeyId: key.id,
		chainId: config.benzonetChainId,
		contract: row.contract,
		from: row.fromAddr,
		logIndex: row.logIndex,
		signedAt: new Date().toISOString(),
		to: row.toAddr,
		token: null,
		txHash: row.txHash,
		version: PROOF_OF_PAYMENT_VERSION,
	};
	const signature = await account.signMessage({
		message: proofOfPaymentMessage(unsigned),
	});

	// Consistent with the auditor read paths, every server-side decrypt is
	// audit-logged. The amount itself is never written to the log.
	await db.insert(auditLog).values({
		action: "disclosure_proof_of_payment",
		actor: requester,
		meta: {
			attestationAddress: unsigned.attestationAddress,
			auditorKeyId: unsigned.auditorKeyId,
			logIndex: unsigned.logIndex,
			txHash: unsigned.txHash,
		},
		subject: `${unsigned.txHash}:${unsigned.logIndex}`,
	});

	return { ok: true, packet: { ...unsigned, signature } };
}
