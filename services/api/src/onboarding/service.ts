import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
	fromDrizzle,
	type Job,
	type JobWithMetadata,
	type PgBoss,
} from "pg-boss";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import {
	drips,
	kycRecords,
	type MockKycPayload,
	onboardings,
	type OnboardingStatus,
	users,
} from "../db/schema.js";
import type { OnboardingChainClient } from "./chain.js";
import type { KycProvider, MockKycInput } from "./kyc.js";

export const ONBOARDING_ADVANCE_QUEUE = "onboarding.advance";
export const ONBOARDING_FAILED_QUEUE = "onboarding.failed";

const retryLimit = 8;
const defaultAdminOnboardingLimit = 100;
const maxAdminOnboardingLimit = 500;
const inProgressStatuses: OnboardingStatus[] = [
	"pending_kyc",
	"kyc_approved",
	"allowlisted",
	"gas_dripped",
	"awaiting_registration",
];

export type OnboardingJobData = {
	address: string;
	mockKyc?: MockKycInput;
	userId: string;
};

export type StartOnboardingInput = {
	address: string;
	mockKyc?: MockKycInput;
	userId: string;
};

export type OnboardingStatusResponse = {
	address: string;
	chainEnv: string;
	chainId: number;
	createdAt: string;
	error: string | null;
	id: string;
	mockKyc: {
		approvedAt: string | null;
		payload: MockKycPayload | null;
		provider: string | null;
	} | null;
	status: OnboardingStatus;
	steps: {
		allowlist: {
			completedAt: string | null;
			result: string | null;
			txHash: string | null;
		};
		gas: {
			completedAt: string | null;
			result: string | null;
			txHash: string | null;
		};
		kyc: {
			completedAt: string | null;
			provider: "mock";
		};
		registration: {
			completedAt: string | null;
			lastCheckedAt: string | null;
		};
	};
	updatedAt: string;
	userId: string;
};

type OnboardingRecord = {
	address: string;
	allowlistedAt: Date | null;
	allowlistResult: string | null;
	allowlistTxHash: string | null;
	chainEnv: string;
	chainId: number;
	createdAt: Date;
	error: string | null;
	gasDrippedAt: Date | null;
	gasDripResult: string | null;
	gasDripTxHash: string | null;
	id: string;
	kycApprovedAt: Date | null;
	kycApprovedRecordAt: Date | null;
	mockKycInput: MockKycInput | null;
	kycPayload: MockKycPayload | null;
	kycProvider: string | null;
	registrationCompletedAt: Date | null;
	registrationLastCheckedAt: Date | null;
	status: OnboardingStatus;
	updatedAt: Date;
	userId: string;
};

export type OnboardingWorkerOptions = {
	chain: OnboardingChainClient;
	config: ApiConfig;
	kycProvider: KycProvider;
};

export type ListAdminOnboardingsInput = {
	limit?: number;
	offset?: number;
	status?: OnboardingStatus;
};

export type AdminOnboardingsResponse = {
	limit: number;
	offset: number;
	onboardings: OnboardingStatusResponse[];
};

export async function startOnboarding(
	db: Database,
	boss: PgBoss,
	config: ApiConfig,
	input: StartOnboardingInput,
): Promise<{
	jobId: string | null;
	onboarding: OnboardingStatusResponse;
}> {
	const result = await db.transaction(async (tx) => {
		const [inserted] = await tx
			.insert(onboardings)
			.values({
				chainEnv: config.chainEnv,
				chainId: config.benzonetChainId,
				mockKycInput: input.mockKyc ?? null,
				status: "pending_kyc",
				userId: input.userId,
			})
			.onConflictDoNothing({ target: onboardings.userId })
			.returning({
				id: onboardings.id,
				mockKycInput: onboardings.mockKycInput,
				status: onboardings.status,
			});
		const row =
			inserted ??
			(
				await tx
					.select({
						id: onboardings.id,
						mockKycInput: onboardings.mockKycInput,
						status: onboardings.status,
					})
					.from(onboardings)
					.where(eq(onboardings.userId, input.userId))
					.limit(1)
			)[0];

		if (!row) {
			throw new Error("onboarding_lookup_failed");
		}

		if (row.status === "complete" || row.status === "failed") {
			return {
				jobId: null,
			};
		}

		const mockKycInput = row.mockKycInput ?? input.mockKyc ?? null;

		if (
			row.status === "pending_kyc" &&
			row.mockKycInput === null &&
			input.mockKyc
		) {
			await tx
				.update(onboardings)
				.set({
					mockKycInput: input.mockKyc,
					updatedAt: new Date(),
				})
				.where(eq(onboardings.userId, input.userId));
		}

		const jobId = await enqueueOnboardingAdvance(boss, {
			data: {
				address: input.address,
				mockKyc: mockKycInput ?? undefined,
				userId: input.userId,
			},
			db: fromDrizzle(tx, sql),
		});

		return {
			jobId,
		};
	});
	const onboarding = await getOnboardingForUser(db, input.userId);

	if (!onboarding) {
		throw new Error("onboarding_lookup_failed");
	}

	return {
		jobId: result.jobId,
		onboarding,
	};
}

export async function getOnboardingForUser(
	db: Database,
	userId: string,
): Promise<OnboardingStatusResponse | null> {
	const row = await selectOnboardingRecord(db, userId);
	return row ? serializeOnboarding(row) : null;
}

export async function listAdminOnboardings(
	db: Database,
	input: ListAdminOnboardingsInput = {},
): Promise<AdminOnboardingsResponse> {
	const limit = normalizeAdminOnboardingLimit(input.limit);
	const offset = normalizeAdminOnboardingOffset(input.offset);
	const rows = await db
		.select(selectOnboardingFields)
		.from(onboardings)
		.innerJoin(users, eq(onboardings.userId, users.id))
		.leftJoin(kycRecords, eq(kycRecords.userId, onboardings.userId))
		.where(input.status ? eq(onboardings.status, input.status) : undefined)
		.orderBy(desc(onboardings.updatedAt))
		.limit(limit)
		.offset(offset);

	return {
		limit,
		offset,
		onboardings: rows.map(serializeOnboarding),
	};
}

export async function enqueueOutstandingOnboardings(
	db: Database,
	boss: PgBoss,
): Promise<number> {
	const rows = await db
		.select({
			address: users.address,
			mockKycInput: onboardings.mockKycInput,
			status: onboardings.status,
			userId: onboardings.userId,
		})
		.from(onboardings)
		.innerJoin(users, eq(onboardings.userId, users.id))
		.where(inArray(onboardings.status, inProgressStatuses));

	await Promise.all(
		rows.map((row) =>
			enqueueOnboardingAdvance(boss, {
				data: {
					address: row.address,
					mockKyc:
						row.status === "pending_kyc"
							? (row.mockKycInput ?? undefined)
							: undefined,
					userId: row.userId,
				},
			}),
		),
	);

	return rows.length;
}

export async function handleOnboardingJob(
	db: Database,
	boss: PgBoss,
	options: OnboardingWorkerOptions,
	job: JobWithMetadata<OnboardingJobData>,
): Promise<void> {
	try {
		await advanceOnboarding(db, boss, options, job.data);
	} catch (error) {
		if (job.retryCount >= job.retryLimit) {
			await markOnboardingFailed(
				db,
				job.data.userId,
				error instanceof Error ? error.message : "onboarding_job_failed",
			);
			return;
		}

		throw error;
	}
}

export async function handleOnboardingFailedJob(
	db: Database,
	job: Job<OnboardingJobData>,
): Promise<void> {
	await markOnboardingFailed(db, job.data.userId, "onboarding_job_failed");
}

async function advanceOnboarding(
	db: Database,
	boss: PgBoss,
	options: OnboardingWorkerOptions,
	data: OnboardingJobData,
): Promise<void> {
	let row = await selectOnboardingRecord(db, data.userId);

	if (!row) {
		return;
	}

	while (true) {
		if (row.status === "complete" || row.status === "failed") {
			return;
		}

		if (row.status === "pending_kyc") {
			await approveMockKyc(
				db,
				options.kycProvider,
				row,
				row.mockKycInput ?? data.mockKyc,
			);
			row = await requireOnboardingRecord(db, data.userId);
			continue;
		}

		if (row.status === "kyc_approved") {
			await completeAllowlistStep(db, options.chain, row);
			row = await requireOnboardingRecord(db, data.userId);
			continue;
		}

		if (row.status === "allowlisted") {
			await completeGasStep(db, options, row);
			row = await requireOnboardingRecord(db, data.userId);
			continue;
		}

		if (row.status === "gas_dripped") {
			// Managed custody (the default): the operator EOA is an admin identity
			// that never holds an encrypted balance — the managed treasury does, and
			// it is eERC-registered separately during treasury provisioning. Nothing
			// registers the operator's own EOA (the backend has no operator key and
			// the console has no client-side prover), so polling for it would hang
			// forever. Complete onboarding once KYC + allowlist + gas have landed.
			// Only a self-custody deployment waits for operator registration.
			if (!options.config.onboardingRequireOperatorRegistration) {
				await markOnboardingRegistered(db, row.userId);
				return;
			}
			await updateOnboarding(db, row.userId, {
				status: "awaiting_registration",
			});
			row = await requireOnboardingRecord(db, data.userId);
			continue;
		}

		if (row.status === "awaiting_registration") {
			// A row can be parked here from before managed onboarding stopped
			// requiring operator registration; complete it immediately rather than
			// polling for a registration that will never arrive.
			if (!options.config.onboardingRequireOperatorRegistration) {
				await markOnboardingRegistered(db, row.userId);
				return;
			}
			await pollRegistration(db, boss, options, row);
			return;
		}

		await markOnboardingFailed(
			db,
			row.userId,
			`unhandled_onboarding_status:${String(row.status)}`,
		);
		return;
	}
}

async function approveMockKyc(
	db: Database,
	kycProvider: KycProvider,
	row: OnboardingRecord,
	input: MockKycInput | undefined,
): Promise<void> {
	const now = new Date();
	const payload = await kycProvider.approve(input ?? {});

	await db.transaction(async (tx) => {
		await tx
			.insert(kycRecords)
			.values({
				approvedAt: now,
				payload,
				provider: kycProvider.name,
				userId: row.userId,
			})
			.onConflictDoUpdate({
				set: {
					approvedAt: now,
					payload,
					provider: kycProvider.name,
				},
				target: kycRecords.userId,
			});

		await tx
			.update(onboardings)
			.set({
				error: null,
				kycApprovedAt: now,
				status: "kyc_approved",
				updatedAt: now,
			})
			.where(eq(onboardings.userId, row.userId));
	});
}

async function completeAllowlistStep(
	db: Database,
	chain: OnboardingChainClient,
	row: OnboardingRecord,
): Promise<void> {
	const result = await chain.ensureAllowlisted(row.address);
	const now = new Date();

	await updateOnboarding(db, row.userId, {
		allowlistedAt: now,
		allowlistResult: result.result,
		allowlistTxHash: result.txHash,
		error: null,
		status: "allowlisted",
	});
}

async function completeGasStep(
	db: Database,
	options: OnboardingWorkerOptions,
	row: OnboardingRecord,
): Promise<void> {
	const balance = await options.chain.getNativeBalance(row.address);
	const now = new Date();

	if (balance >= options.config.dripBalanceThresholdWei) {
		await updateOnboarding(db, row.userId, {
			error: null,
			gasDrippedAt: now,
			gasDripResult: "balance_sufficient",
			gasDripTxHash: null,
			status: "gas_dripped",
		});
		return;
	}

	const recentDrip = await findRecentDrip(db, row.address);

	if (recentDrip) {
		await updateOnboarding(db, row.userId, {
			error: null,
			gasDrippedAt: now,
			gasDripResult: "rate_limited_existing",
			gasDripTxHash: recentDrip.txHash,
			status: "gas_dripped",
		});
		return;
	}

	const result = await options.chain.dripGas(
		row.address,
		options.config.dripWei,
	);

	if (result.result === "balance_sufficient") {
		await updateOnboarding(db, row.userId, {
			error: null,
			gasDrippedAt: now,
			gasDripResult: result.result,
			gasDripTxHash: null,
			status: "gas_dripped",
		});
		return;
	}

	await db.transaction(async (tx) => {
		await tx.insert(drips).values({
			address: row.address,
			amountWei: options.config.dripWei.toString(),
			chainEnv: options.chain.chainEnv,
			chainId: options.chain.chainId,
			mode: result.mode,
			txHash: result.txHash,
			userId: row.userId,
		});

		await tx
			.update(onboardings)
			.set({
				error: null,
				gasDrippedAt: now,
				gasDripResult: `${result.mode}_sent`,
				gasDripTxHash: result.txHash,
				status: "gas_dripped",
				updatedAt: now,
			})
			.where(eq(onboardings.userId, row.userId));
	});
}

async function markOnboardingRegistered(
	db: Database,
	userId: string,
): Promise<void> {
	const now = new Date();
	await updateOnboarding(db, userId, {
		error: null,
		registrationCompletedAt: now,
		registrationLastCheckedAt: now,
		status: "complete",
	});
}

async function pollRegistration(
	db: Database,
	boss: PgBoss,
	options: OnboardingWorkerOptions,
	row: OnboardingRecord,
): Promise<void> {
	const now = new Date();
	const registered = await options.chain.isUserRegistered(row.address);

	if (registered) {
		await updateOnboarding(db, row.userId, {
			error: null,
			registrationCompletedAt: now,
			registrationLastCheckedAt: now,
			status: "complete",
		});
		return;
	}

	await updateOnboarding(db, row.userId, {
		error: null,
		registrationLastCheckedAt: now,
		status: "awaiting_registration",
	});
	await enqueueOnboardingAdvance(boss, {
		data: {
			address: row.address,
			userId: row.userId,
		},
		startAfterSeconds: options.config.onboardingRegistrationPollSeconds,
	});
}

async function findRecentDrip(
	db: Database,
	address: string,
): Promise<{ txHash: string } | null> {
	const cutoff = new Date(Date.now() - 86_400_000);
	const [row] = await db
		.select({
			txHash: drips.txHash,
		})
		.from(drips)
		.where(and(eq(drips.address, address), gte(drips.drippedAt, cutoff)))
		.orderBy(desc(drips.drippedAt))
		.limit(1);

	return row ?? null;
}

async function markOnboardingFailed(
	db: Database,
	userId: string,
	error: string,
): Promise<void> {
	await updateOnboarding(db, userId, {
		error,
		status: "failed",
	});
}

async function enqueueOnboardingAdvance(
	boss: PgBoss,
	input: {
		data: OnboardingJobData;
		db?: ReturnType<typeof fromDrizzle>;
		startAfterSeconds?: number;
	},
): Promise<string | null> {
	const response = await boss.upsert(
		ONBOARDING_ADVANCE_QUEUE,
		input.data,
		{
			db: input.db,
			retryBackoff: true,
			retryLimit,
			singletonKey: input.data.address,
			startAfter: input.startAfterSeconds,
		},
	);

	return response.jobs[0] ?? null;
}

async function updateOnboarding(
	db: Database,
	userId: string,
	values: Partial<typeof onboardings.$inferInsert>,
): Promise<void> {
	await db
		.update(onboardings)
		.set({
			...values,
			updatedAt: new Date(),
		})
		.where(eq(onboardings.userId, userId));
}

async function requireOnboardingRecord(
	db: Database,
	userId: string,
): Promise<OnboardingRecord> {
	const row = await selectOnboardingRecord(db, userId);

	if (!row) {
		throw new Error("onboarding_lookup_failed");
	}

	return row;
}

async function selectOnboardingRecord(
	db: Database,
	userId: string,
): Promise<OnboardingRecord | null> {
	const [row] = await db
		.select(selectOnboardingFields)
		.from(onboardings)
		.innerJoin(users, eq(onboardings.userId, users.id))
		.leftJoin(kycRecords, eq(kycRecords.userId, onboardings.userId))
		.where(eq(onboardings.userId, userId))
		.limit(1);

	return row ?? null;
}

const selectOnboardingFields = {
	address: users.address,
	allowlistedAt: onboardings.allowlistedAt,
	allowlistResult: onboardings.allowlistResult,
	allowlistTxHash: onboardings.allowlistTxHash,
	chainEnv: onboardings.chainEnv,
	chainId: onboardings.chainId,
	createdAt: onboardings.createdAt,
	error: onboardings.error,
	gasDrippedAt: onboardings.gasDrippedAt,
	gasDripResult: onboardings.gasDripResult,
	gasDripTxHash: onboardings.gasDripTxHash,
	id: onboardings.id,
	kycApprovedAt: onboardings.kycApprovedAt,
	kycApprovedRecordAt: kycRecords.approvedAt,
	mockKycInput: onboardings.mockKycInput,
	kycPayload: kycRecords.payload,
	kycProvider: kycRecords.provider,
	registrationCompletedAt: onboardings.registrationCompletedAt,
	registrationLastCheckedAt: onboardings.registrationLastCheckedAt,
	status: onboardings.status,
	updatedAt: onboardings.updatedAt,
	userId: onboardings.userId,
} satisfies Record<string, unknown>;

function serializeOnboarding(row: OnboardingRecord): OnboardingStatusResponse {
	return {
		address: row.address,
		chainEnv: row.chainEnv,
		chainId: row.chainId,
		createdAt: row.createdAt.toISOString(),
		error: row.error,
		id: row.id,
		mockKyc: {
			approvedAt: row.kycApprovedRecordAt?.toISOString() ?? null,
			payload: row.kycPayload,
			provider: row.kycProvider,
		},
		status: row.status,
		steps: {
			allowlist: {
				completedAt: row.allowlistedAt?.toISOString() ?? null,
				result: row.allowlistResult,
				txHash: row.allowlistTxHash,
			},
			gas: {
				completedAt: row.gasDrippedAt?.toISOString() ?? null,
				result: row.gasDripResult,
				txHash: row.gasDripTxHash,
			},
			kyc: {
				completedAt: row.kycApprovedAt?.toISOString() ?? null,
				provider: "mock",
			},
			registration: {
				completedAt: row.registrationCompletedAt?.toISOString() ?? null,
				lastCheckedAt: row.registrationLastCheckedAt?.toISOString() ?? null,
			},
		},
		updatedAt: row.updatedAt.toISOString(),
		userId: row.userId,
	};
}

function normalizeAdminOnboardingLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) {
		return defaultAdminOnboardingLimit;
	}

	return Math.min(
		Math.max(Math.trunc(limit ?? defaultAdminOnboardingLimit), 1),
		maxAdminOnboardingLimit,
	);
}

function normalizeAdminOnboardingOffset(offset: number | undefined): number {
	if (!Number.isFinite(offset)) {
		return 0;
	}

	return Math.max(Math.trunc(offset ?? 0), 0);
}
