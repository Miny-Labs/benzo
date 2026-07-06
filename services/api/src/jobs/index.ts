import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { fromDrizzle, PgBoss, type Job } from "pg-boss";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { auditLog } from "../db/schema.js";

export const JOB_QUEUES = {
	demoAudit: "demo.audit",
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

export function createBoss(config: ApiConfig): PgBoss {
	return new PgBoss({
		application_name: "benzo-api",
		connectionString: config.databaseUrl,
	});
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
	await boss.createQueue(JOB_QUEUES.demoAudit, {
		deleteAfterSeconds: 86_400,
		retryLimit: 3,
		retentionSeconds: 604_800,
	});
}

export async function registerJobs(
	boss: PgBoss,
	db: Database,
	logger: FastifyBaseLogger,
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
