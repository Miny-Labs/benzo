import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
	onrampIntents,
	type OnrampDestToken,
	type OnrampStatus,
} from "../db/schema.js";

// Onramp intent state machine + persistence. The relayer job (#111) is the
// primary driver of these transitions; the routes in this issue only create
// intents (in `initiated`) and read them back.
//
// Forward flow: initiated → burned → attested → minted → credited. A recipient
// that is not eERC-registered by settle time parks in `needs_onboarding` and can
// resume once registered. Any non-terminal state may fail. `credited` and
// `failed` are terminal.
const TERMINAL: readonly OnrampStatus[] = ["credited", "failed"];

const TRANSITIONS: Record<OnrampStatus, readonly OnrampStatus[]> = {
	initiated: ["burned", "needs_onboarding", "failed"],
	burned: ["attested", "needs_onboarding", "failed"],
	attested: ["minted", "needs_onboarding", "failed"],
	minted: ["credited", "failed"],
	needs_onboarding: ["attested", "minted", "credited", "failed"],
	credited: [],
	failed: [],
};

export function isTerminalStatus(status: OnrampStatus): boolean {
	return TERMINAL.includes(status);
}

export function canTransition(from: OnrampStatus, to: OnrampStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OnrampStatus, to: OnrampStatus): void {
	if (!canTransition(from, to)) {
		throw new Error(`invalid_onramp_transition:${from}:${to}`);
	}
}

export type OnrampIntentRow = typeof onrampIntents.$inferSelect;

export type CreateIntentInput = {
	userId: string;
	userAddress: string;
	sourceDomain: number;
	sourceChainId: number;
	sourceTxHash: string;
	destToken: OnrampDestToken;
	userPubKeyX: string;
	userPubKeyY: string;
	amount?: string | null;
};

export type CreateIntentResult = {
	intent: OnrampIntentRow;
	created: boolean;
};

/**
 * Insert a new intent (status `initiated`). Idempotent on the unique
 * sourceTxHash: a repeat submission returns the existing row with
 * `created: false` instead of throwing on the constraint.
 */
export async function createIntent(
	db: Database,
	input: CreateIntentInput,
): Promise<CreateIntentResult> {
	const sourceTxHash = input.sourceTxHash.toLowerCase();
	const [inserted] = await db
		.insert(onrampIntents)
		.values({
			amount: input.amount ?? null,
			destToken: input.destToken,
			sourceChainId: input.sourceChainId,
			sourceDomain: input.sourceDomain,
			sourceTxHash,
			status: "initiated",
			userAddress: input.userAddress.toLowerCase(),
			userId: input.userId,
			userPubKeyX: input.userPubKeyX,
			userPubKeyY: input.userPubKeyY,
		})
		.onConflictDoNothing({ target: onrampIntents.sourceTxHash })
		.returning();

	if (inserted) {
		return { intent: inserted, created: true };
	}

	const existing = await getIntentBySourceTxHash(db, sourceTxHash);

	if (!existing) {
		throw new Error("onramp_intent_lookup_failed");
	}

	return { intent: existing, created: false };
}

export async function getIntentById(
	db: Database,
	id: string,
): Promise<OnrampIntentRow | null> {
	const [row] = await db
		.select()
		.from(onrampIntents)
		.where(eq(onrampIntents.id, id))
		.limit(1);

	return row ?? null;
}

export async function getIntentBySourceTxHash(
	db: Database,
	sourceTxHash: string,
): Promise<OnrampIntentRow | null> {
	const [row] = await db
		.select()
		.from(onrampIntents)
		.where(eq(onrampIntents.sourceTxHash, sourceTxHash.toLowerCase()))
		.limit(1);

	return row ?? null;
}

export async function listIntentsByAddress(
	db: Database,
	address: string,
	limit = 100,
): Promise<OnrampIntentRow[]> {
	return db
		.select()
		.from(onrampIntents)
		.where(eq(onrampIntents.userAddress, address.toLowerCase()))
		.orderBy(desc(onrampIntents.updatedAt))
		.limit(limit);
}

export type TransitionPatch = Partial<
	Pick<
		OnrampIntentRow,
		| "amount"
		| "cctpNonce"
		| "messageHash"
		| "settleTxHash"
		| "error"
	>
>;

/**
 * Move an intent to `to`, validating the transition against the state machine.
 * The compare-and-set on the current status is atomic, so a concurrent
 * transition either wins or leaves this call to throw
 * `onramp_intent_transition_conflict` rather than silently clobbering state.
 */
export async function transitionIntent(
	db: Database,
	id: string,
	to: OnrampStatus,
	patch: TransitionPatch = {},
): Promise<OnrampIntentRow> {
	const current = await getIntentById(db, id);

	if (!current) {
		throw new Error("onramp_intent_not_found");
	}

	assertTransition(current.status, to);

	const [updated] = await db
		.update(onrampIntents)
		.set({ ...patch, status: to, updatedAt: new Date() })
		.where(
			and(eq(onrampIntents.id, id), eq(onrampIntents.status, current.status)),
		)
		.returning();

	if (!updated) {
		throw new Error("onramp_intent_transition_conflict");
	}

	return updated;
}

export type SerializedOnrampIntent = {
	id: string;
	userAddress: string;
	sourceDomain: number;
	sourceChainId: number;
	sourceTxHash: string;
	destToken: OnrampDestToken;
	amount: string | null;
	userPubKeyX: string;
	userPubKeyY: string;
	cctpNonce: string | null;
	messageHash: string | null;
	status: OnrampStatus;
	settleTxHash: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
};

export function serializeIntent(row: OnrampIntentRow): SerializedOnrampIntent {
	return {
		id: row.id,
		userAddress: row.userAddress,
		sourceDomain: row.sourceDomain,
		sourceChainId: row.sourceChainId,
		sourceTxHash: row.sourceTxHash,
		destToken: row.destToken,
		amount: row.amount,
		userPubKeyX: row.userPubKeyX,
		userPubKeyY: row.userPubKeyY,
		cctpNonce: row.cctpNonce,
		messageHash: row.messageHash,
		status: row.status,
		settleTxHash: row.settleTxHash,
		error: row.error,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
