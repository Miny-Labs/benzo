import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { fromDrizzle, PgBoss, type Job, type JobWithMetadata } from "pg-boss";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { expireCreatedInvites } from "../identity/invites.js";
import type { ChainLogSource } from "../indexer/chain.js";
import { runIndexerOnce } from "../indexer/scanner.js";
import {
	enqueueOutstandingOnboardings,
	handleOnboardingFailedJob,
	handleOnboardingJob,
	ONBOARDING_ADVANCE_QUEUE,
	ONBOARDING_FAILED_QUEUE,
	type OnboardingJobData,
	type OnboardingWorkerOptions,
} from "../onboarding/service.js";
import {
	enqueueOutstandingPayrollItems,
	handlePayrollItemJob,
	PAYROLL_ITEM_QUEUE,
	type PayrollItemJobData,
	type PayrollWorkerOptions,
} from "../payroll/runner.js";
import {
	handleOnrampPollJob,
	ONRAMP_POLL_QUEUE,
	type OnrampPollerOptions,
	type OnrampPollJobData,
} from "../onramp/poller.js";
import {
	handleTreasuryReconcileJob,
	TREASURY_RECONCILE_QUEUE,
	type TreasuryReconcileJobData,
	type TreasuryReconcilerOptions,
} from "../treasury/reconciler.js";

export const JOB_QUEUES = {
	demoAudit: "demo.audit",
	eercIndexer: "eerc.indexer.poll",
	invitesExpire: "invites.expire",
	onrampPoll: ONRAMP_POLL_QUEUE,
	onboardingAdvance: ONBOARDING_ADVANCE_QUEUE,
	onboardingFailed: ONBOARDING_FAILED_QUEUE,
	payrollItem: PAYROLL_ITEM_QUEUE,
	treasuryReconcile: TREASURY_RECONCILE_QUEUE,
} as const;

export type DemoAuditJobData = {
	actor: string;
	requestedAt: string;
	subject: string;
};

export type EnqueueDemoAuditJobInput = {
	actor: string;
	subject: string;
};

export type InviteExpireJobData = {
	scheduled: true;
};

type EercIndexerJobData = {
	requestedAt: string;
};

export function createBoss(config: ApiConfig): PgBoss {
	return new PgBoss({
		application_name: "benzo-api",
		connectionString: config.databaseUrl,
		cronMonitorIntervalSeconds: 5,
		cronWorkerIntervalSeconds: 5,
	});
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
	await boss.createQueue(JOB_QUEUES.demoAudit, {
		deleteAfterSeconds: 86_400,
		retryLimit: 3,
		retentionSeconds: 604_800,
	});
	await boss.createQueue(JOB_QUEUES.onboardingFailed, {
		deleteAfterSeconds: 604_800,
		retentionSeconds: 2_592_000,
	});
	await boss.createQueue(JOB_QUEUES.onboardingAdvance, {
		deadLetter: JOB_QUEUES.onboardingFailed,
		deleteAfterSeconds: 604_800,
		expireInSeconds: 60,
		policy: "key_strict_fifo",
		retentionSeconds: 2_592_000,
		retryBackoff: true,
		retryLimit: 8,
	});
	await boss.createQueue(JOB_QUEUES.invitesExpire, {
		deleteAfterSeconds: 86_400,
		retryLimit: 3,
		retentionSeconds: 604_800,
	});
	await boss.schedule(
		JOB_QUEUES.invitesExpire,
		"0 * * * *",
		{ scheduled: true } satisfies InviteExpireJobData,
		{ key: "hourly" },
	);
	await boss.createQueue(JOB_QUEUES.eercIndexer, {
		deleteAfterSeconds: 86_400,
		expireInSeconds: 60,
		retryLimit: 2,
		retentionSeconds: 604_800,
	});
	await boss.createQueue(JOB_QUEUES.payrollItem, {
		deleteAfterSeconds: 2_592_000,
		expireInSeconds: 3_600,
		retentionSeconds: 2_592_000,
		retryBackoff: true,
		retryLimit: 5,
	});
	await boss.createQueue(JOB_QUEUES.onrampPoll, {
		deleteAfterSeconds: 604_800,
		expireInSeconds: 300,
		retentionSeconds: 2_592_000,
		retryBackoff: true,
		retryLimit: 5,
	});
	await boss.createQueue(JOB_QUEUES.treasuryReconcile, {
		deleteAfterSeconds: 604_800,
		expireInSeconds: 300,
		retentionSeconds: 2_592_000,
		retryBackoff: true,
		retryLimit: 5,
	});
}

export async function registerJobs(
	boss: PgBoss,
	db: Database,
	logger: FastifyBaseLogger,
	onboarding?: OnboardingWorkerOptions,
	options?: {
		chain?: ChainLogSource;
		config?: ApiConfig;
	},
	payroll?: PayrollWorkerOptions,
	onramp?: OnrampPollerOptions,
	treasury?: TreasuryReconcilerOptions,
): Promise<void> {
	await ensureQueues(boss);
	await boss.work<DemoAuditJobData>(
		JOB_QUEUES.demoAudit,
		{ batchSize: 1 },
		async ([job]) => {
			if (!job) {
				return;
			}

			await recordDemoJob(db, job);
			logger.info(
				{ jobId: job.id, queue: JOB_QUEUES.demoAudit },
				"demo audit job processed",
			);
		},
	);

	await boss.work<InviteExpireJobData>(
		JOB_QUEUES.invitesExpire,
		{ batchSize: 1 },
		async ([job]) => {
			if (!job) {
				return;
			}

			const expiredCount = await expireCreatedInvites(db);
			logger.info(
				{ expiredCount, jobId: job.id, queue: JOB_QUEUES.invitesExpire },
				"expired stale invites",
			);
		},
	);

	if (options?.config?.indexerEnabled && options.chain) {
		await boss.schedule(
			JOB_QUEUES.eercIndexer,
			options.config.indexerPollCron,
			{
				requestedAt: new Date().toISOString(),
			},
			{
				singletonKey: "eerc-indexer-poll",
				singletonSeconds: 4,
			},
		);
		await boss.work<EercIndexerJobData>(
			JOB_QUEUES.eercIndexer,
			{ batchSize: 1 },
			async ([job]) => {
				if (!job || !options.config || !options.chain) {
					return;
				}

				const result = await runIndexerOnce({
					chain: options.chain,
					config: options.config,
					db,
					logger,
				});

				logger.info(
					{
						confirmedBlock: result.confirmedBlock,
						jobId: job.id,
						latestBlock: result.latestBlock,
						queue: JOB_QUEUES.eercIndexer,
						requestedAt: job.data.requestedAt,
					},
					"eerc indexer poll processed",
				);
			},
		);
	}

	if (onboarding) {
		await boss.work<OnboardingJobData>(
			JOB_QUEUES.onboardingAdvance,
			{ batchSize: 1, includeMetadata: true, localConcurrency: 4 },
			async ([job]) => {
				if (!job) {
					return;
				}

				await handleOnboardingJob(
					db,
					boss,
					onboarding,
					job as JobWithMetadata<OnboardingJobData>,
				);
				logger.info(
					{ jobId: job.id, queue: JOB_QUEUES.onboardingAdvance },
					"onboarding job processed",
				);
			},
		);
		await boss.work<OnboardingJobData>(
			JOB_QUEUES.onboardingFailed,
			{ batchSize: 1 },
			async ([job]) => {
				if (!job) {
					return;
				}

				await handleOnboardingFailedJob(db, job);
				logger.error(
					{ jobId: job.id, queue: JOB_QUEUES.onboardingFailed },
					"onboarding job failed terminally",
				);
			},
		);

		const resumed = await enqueueOutstandingOnboardings(db, boss);

		if (resumed > 0) {
			logger.info({ count: resumed }, "resumed onboarding jobs");
		}
	}

	if (payroll) {
		await boss.work<PayrollItemJobData>(
			JOB_QUEUES.payrollItem,
			{ batchSize: 1, localConcurrency: 3 },
			async ([job]) => {
				if (!job) {
					return;
				}

				await handlePayrollItemJob(db, payroll, job);
				logger.info(
					{ jobId: job.id, queue: JOB_QUEUES.payrollItem },
					"payroll item job processed",
				);
			},
		);

		const resumedPayrollItems = await enqueueOutstandingPayrollItems(db, boss);
		if (resumedPayrollItems > 0) {
			logger.info({ count: resumedPayrollItems }, "resumed payroll item jobs");
		}
	}

	if (onramp?.config.onrampPollerEnabled) {
		await boss.schedule(
			JOB_QUEUES.onrampPoll,
			onramp.config.onrampPollCron,
			{
				requestedAt: new Date().toISOString(),
			},
			{
				singletonKey: "onramp-poll",
				singletonSeconds: 4,
			},
		);

		await boss.work<OnrampPollJobData>(
			JOB_QUEUES.onrampPoll,
			{ batchSize: 1, localConcurrency: 1 },
			async ([job]) => {
				if (!job) {
					return;
				}

				const result = await handleOnrampPollJob(db, onramp);
				logger.info(
					{
						credited: result.credited,
						failed: result.failed,
						jobId: job.id,
						parked: result.parked,
						pending: result.pending,
						polled: result.polled,
						queue: JOB_QUEUES.onrampPoll,
						relayerConfigured: result.relayerConfigured,
						requestedAt: job.data.requestedAt,
						routerConfigured: result.routerConfigured,
					},
					"onramp poll job processed",
				);
			},
		);
	}

	if (treasury?.config.treasuryReconcilerEnabled) {
		await boss.schedule(
			JOB_QUEUES.treasuryReconcile,
			treasury.config.treasuryReconcileCron,
			{
				requestedAt: new Date().toISOString(),
			},
			{
				singletonKey: "treasury-reconcile",
				singletonSeconds: 4,
			},
		);

		await boss.work<TreasuryReconcileJobData>(
			JOB_QUEUES.treasuryReconcile,
			{ batchSize: 1, localConcurrency: 1 },
			async ([job]) => {
				if (!job) {
					return;
				}

				const result = await handleTreasuryReconcileJob(db, treasury);
				logger.info(
					{
						confirmed: result.confirmed,
						failed: result.failed,
						jobId: job.id,
						pending: result.pending,
						polled: result.polled,
						queue: JOB_QUEUES.treasuryReconcile,
						requestedAt: job.data.requestedAt,
						skipped: result.skipped,
					},
					"treasury reconcile job processed",
				);
			},
		);
	}
}

export async function enqueueDemoAuditJob(
	db: Database,
	boss: PgBoss,
	input: EnqueueDemoAuditJobInput,
): Promise<string | null> {
	const singletonKey = `${input.actor}:${input.subject}`;
	const requestedAt = new Date().toISOString();

	return db.transaction(async (tx) => {
		const jobId = await boss.send(
			JOB_QUEUES.demoAudit,
			{
				actor: input.actor,
				requestedAt,
				subject: input.subject,
			},
			{
				db: fromDrizzle(tx, sql),
				singletonKey,
				singletonSeconds: 86_400,
			},
		);

		if (!jobId) {
			return null;
		}

		await tx.insert(auditLog).values({
			action: "demo_job_enqueued",
			actor: input.actor,
			meta: {
				queue: JOB_QUEUES.demoAudit,
				singletonKey,
			},
			subject: input.subject,
		});

		return jobId;
	});
}

async function recordDemoJob(
	db: Database,
	job: Job<DemoAuditJobData>,
): Promise<void> {
	await db.insert(auditLog).values({
		action: "demo_job_processed",
		actor: job.data.actor,
		meta: {
			jobId: job.id,
			queue: JOB_QUEUES.demoAudit,
			requestedAt: job.data.requestedAt,
		},
		subject: job.data.subject,
	});
}
