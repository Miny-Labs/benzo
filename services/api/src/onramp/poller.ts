import { asc, eq, inArray } from "drizzle-orm";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import {
	onrampIntents,
	users,
	type OnrampStatus,
} from "../db/schema.js";
import type { OnrampChainClient } from "./chain.js";
import type { IrisClient, IrisMessage } from "./cctp.js";
import { computeOnrampAmountPCT } from "./amountpct.js";
import {
	decodeCctpOnrampMessage,
	type DecodedCctpOnrampMessage,
} from "./message.js";
import {
	OnrampRecipientNotRegisteredError,
	type OnrampRelayer,
	type SettleDepositResult,
} from "./relayer.js";
import {
	canTransition,
	transitionIntent,
	type OnrampIntentRow,
	type TransitionPatch,
} from "./service.js";
import { getAddress, type Hex } from "viem";

export const ONRAMP_POLL_QUEUE = "onramp.poll";

export type OnrampPollJobData = {
	requestedAt: string;
};

export type OnrampPollerOptions = {
	chain: OnrampChainClient;
	config: ApiConfig;
	iris: IrisClient;
	limit?: number;
	relayer: OnrampRelayer;
};

export type OnrampPollResult = {
	credited: number;
	failed: number;
	parked: number;
	pending: number;
	polled: number;
	routerConfigured: boolean;
	skipped: number;
};

const NON_TERMINAL_STATUSES: OnrampStatus[] = [
	"initiated",
	"burned",
	"attested",
	"minted",
	"needs_onboarding",
];

const DEFAULT_POLL_LIMIT = 50;

export async function handleOnrampPollJob(
	db: Database,
	options: OnrampPollerOptions,
): Promise<OnrampPollResult> {
	return pollOnrampIntents(db, options);
}

export async function pollOnrampIntents(
	db: Database,
	options: OnrampPollerOptions,
): Promise<OnrampPollResult> {
	const result: OnrampPollResult = {
		credited: 0,
		failed: 0,
		parked: 0,
		pending: 0,
		polled: 0,
		routerConfigured: options.config.autoDepositRouterAddress !== null,
		skipped: 0,
	};

	if (!options.config.autoDepositRouterAddress) {
		return result;
	}

	const intents = await db
		.select()
		.from(onrampIntents)
		.where(inArray(onrampIntents.status, NON_TERMINAL_STATUSES))
		.orderBy(asc(onrampIntents.updatedAt))
		.limit(options.limit ?? DEFAULT_POLL_LIMIT);

	for (const intent of intents) {
		result.polled += 1;
		const outcome = await processIntent(db, options, intent);
		result[outcome] += 1;
	}

	return result;
}

type PollOutcome = keyof Pick<
	OnrampPollResult,
	"credited" | "failed" | "parked" | "pending" | "skipped"
>;

async function processIntent(
	db: Database,
	options: OnrampPollerOptions,
	intent: OnrampIntentRow,
): Promise<PollOutcome> {
	if (intent.status === "minted" && intent.settleTxHash) {
		await transitionIntent(db, intent.id, "credited", { error: null });
		return "credited";
	}

	const irisMessages = await options.iris.getMessages(
		intent.sourceDomain,
		intent.sourceTxHash,
	);
	const irisMessage = selectIrisMessage(intent, irisMessages);

	if (!irisMessage) {
		return "pending";
	}

	if (!isCompleteIrisMessage(irisMessage)) {
		await markBurned(db, intent, irisMessage);
		return "pending";
	}

	const message = requireHex(irisMessage.message, "message");
	const attestation = requireHex(irisMessage.attestation, "attestation");
	const decoded = decodeCctpOnrampMessage(message);

	if (decoded.sourceDomain !== intent.sourceDomain) {
		await failIntent(db, intent, "cctp_source_domain_mismatch");
		return "failed";
	}

	if (decoded.destinationDomain !== options.config.cctpDestDomain) {
		await failIntent(db, intent, "cctp_destination_domain_mismatch");
		return "failed";
	}

	const router = options.config.autoDepositRouterAddress;
	if (!router) {
		return "skipped";
	}

	if (getAddress(decoded.mintRecipient) !== getAddress(router)) {
		await failIntent(db, intent, "cctp_mint_recipient_mismatch");
		return "failed";
	}

	const reassociated = await reassociateIntent(db, intent, decoded);
	const registration = await options.chain.resolveUserKey(decoded.hookData.user);

	if (!registration.registered || !registration.publicKey) {
		await parkNeedsOnboarding(db, reassociated, decoded);
		return "parked";
	}

	if (
		registration.publicKey[0] !== decoded.hookData.pkX ||
		registration.publicKey[1] !== decoded.hookData.pkY
	) {
		await failIntent(db, reassociated, "recipient_public_key_mismatch");
		return "failed";
	}

	const attested = await advanceToAttested(db, reassociated, decoded);
	const amountPCT = computeOnrampAmountPCT(decoded.mintedAmount, [
		decoded.hookData.pkX,
		decoded.hookData.pkY,
	]);

	let settle: SettleDepositResult;

	try {
		settle = await options.relayer.settleDeposit({
			amountPCT,
			attestation,
			confirmations: options.config.indexerConfirmations,
			message,
		});
	} catch (error) {
		if (error instanceof OnrampRecipientNotRegisteredError) {
			await parkNeedsOnboarding(db, attested, decoded);
			return "parked";
		}

		throw error;
	}

	await markCredited(db, attested, settle);
	return "credited";
}

function selectIrisMessage(
	intent: OnrampIntentRow,
	messages: IrisMessage[],
): IrisMessage | null {
	if (messages.length === 0) {
		return null;
	}

	if (intent.cctpNonce) {
		const expected = intent.cctpNonce.toLowerCase();
		const byNonce = messages.find((message) => {
			if (message.eventNonce?.toLowerCase() === expected) {
				return true;
			}

			return safeDecodedNonce(message.message) === expected;
		});

		if (byNonce) {
			return byNonce;
		}
	}

	return (
		messages.find((message) => isCompleteIrisMessage(message)) ??
		messages[0] ??
		null
	);
}

function isCompleteIrisMessage(message: IrisMessage): boolean {
	return message.status.toLowerCase() === "complete";
}

function safeDecodedNonce(message: string | null | undefined): string | null {
	if (!message || !isHexBytes(message)) {
		return null;
	}

	try {
		return decodeCctpOnrampMessage(message as Hex).nonce.toLowerCase();
	} catch {
		return null;
	}
}

async function markBurned(
	db: Database,
	intent: OnrampIntentRow,
	message: IrisMessage,
): Promise<void> {
	if (intent.status !== "initiated") {
		await patchIntent(db, intent.id, {
			cctpNonce: message.eventNonce ?? intent.cctpNonce,
			error: null,
		});
		return;
	}

	await transitionIntent(db, intent.id, "burned", {
		cctpNonce: message.eventNonce ?? intent.cctpNonce,
		error: null,
	});
}

async function reassociateIntent(
	db: Database,
	intent: OnrampIntentRow,
	decoded: DecodedCctpOnrampMessage,
): Promise<OnrampIntentRow> {
	const userAddress = decoded.hookData.user.toLowerCase();
	const userId = await ensureUserForAddress(db, userAddress);

	return patchIntent(db, intent.id, {
		amount: decoded.mintedAmount.toString(),
		cctpNonce: decoded.nonce,
		error: null,
		messageHash: decoded.messageHash,
		userAddress,
		userId,
		userPubKeyX: decoded.hookData.pkX.toString(),
		userPubKeyY: decoded.hookData.pkY.toString(),
	});
}

async function ensureUserForAddress(
	db: Database,
	address: string,
): Promise<string> {
	const [user] = await db
		.insert(users)
		.values({ address: address.toLowerCase() })
		.onConflictDoUpdate({
			set: { address: address.toLowerCase() },
			target: users.address,
		})
		.returning({ id: users.id });

	if (!user) {
		throw new Error("onramp_user_reassociation_failed");
	}

	return user.id;
}

async function advanceToAttested(
	db: Database,
	intent: OnrampIntentRow,
	decoded: DecodedCctpOnrampMessage,
): Promise<OnrampIntentRow> {
	let current = intent;
	const patch = attestationPatch(decoded);

	if (current.status === "initiated") {
		current = await transitionIntent(db, current.id, "burned", patch);
	}

	if (current.status === "burned" || current.status === "needs_onboarding") {
		return transitionIntent(db, current.id, "attested", patch);
	}

	if (current.status === "attested") {
		return patchIntent(db, current.id, patch);
	}

	return current;
}

async function parkNeedsOnboarding(
	db: Database,
	intent: OnrampIntentRow,
	decoded: DecodedCctpOnrampMessage,
): Promise<OnrampIntentRow> {
	const patch = {
		...attestationPatch(decoded),
		error: "recipient_not_eerc_registered",
	};

	if (intent.status === "needs_onboarding") {
		return patchIntent(db, intent.id, patch);
	}

	if (!canTransition(intent.status, "needs_onboarding")) {
		return patchIntent(db, intent.id, patch);
	}

	return transitionIntent(db, intent.id, "needs_onboarding", patch);
}

async function failIntent(
	db: Database,
	intent: OnrampIntentRow,
	error: string,
): Promise<OnrampIntentRow> {
	if (intent.status === "failed") {
		return patchIntent(db, intent.id, { error });
	}

	if (!canTransition(intent.status, "failed")) {
		return patchIntent(db, intent.id, { error });
	}

	return transitionIntent(db, intent.id, "failed", { error });
}

async function markCredited(
	db: Database,
	intent: OnrampIntentRow,
	settle: SettleDepositResult,
): Promise<OnrampIntentRow> {
	let current = intent;
	const settleTxHash = settle.txHash ?? current.settleTxHash;

	if (current.status === "attested") {
		current = await transitionIntent(db, current.id, "minted", {
			error: null,
			settleTxHash,
		});
	}

	if (current.status === "minted") {
		return transitionIntent(db, current.id, "credited", {
			error: null,
			settleTxHash,
		});
	}

	return current;
}

type IntentPatch = TransitionPatch &
	Partial<
		Pick<
			OnrampIntentRow,
			"userAddress" | "userId" | "userPubKeyX" | "userPubKeyY"
		>
	>;

async function patchIntent(
	db: Database,
	id: string,
	patch: IntentPatch,
): Promise<OnrampIntentRow> {
	const [updated] = await db
		.update(onrampIntents)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(onrampIntents.id, id))
		.returning();

	if (!updated) {
		throw new Error("onramp_intent_not_found");
	}

	return updated;
}

function attestationPatch(
	decoded: DecodedCctpOnrampMessage,
): TransitionPatch {
	return {
		amount: decoded.mintedAmount.toString(),
		cctpNonce: decoded.nonce,
		error: null,
		messageHash: decoded.messageHash,
	};
}

function requireHex(
	value: string | null | undefined,
	label: string,
): Hex {
	if (!value) {
		throw new Error(`iris_${label}_missing`);
	}

	if (!isHexBytes(value)) {
		throw new Error(`invalid_iris_${label}`);
	}

	return value as Hex;
}

function isHexBytes(value: string): boolean {
	return /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}
