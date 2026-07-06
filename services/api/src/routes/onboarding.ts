import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import type { OnboardingStatus } from "../db/schema.js";
import {
	getOnboardingForUser,
	listAdminOnboardings,
	startOnboarding,
} from "../onboarding/service.js";
import type { PgBoss } from "pg-boss";

const mockKycSchema = z.object({
	country: z.string().trim().min(2).max(64).optional(),
	name: z.string().trim().min(1).max(120).optional(),
});

const startBodySchema = z
	.object({
		mockKyc: mockKycSchema.optional(),
	})
	.optional();

const adminOnboardingsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(100),
	offset: z.coerce.number().int().min(0).default(0),
	status: z
		.enum([
			"pending_kyc",
			"kyc_approved",
			"allowlisted",
			"gas_dripped",
			"awaiting_registration",
			"complete",
			"failed",
		])
		.optional(),
});

type OnboardingRoutesOptions = {
	boss: PgBoss;
	config: ApiConfig;
	db: Database;
};

export const onboardingRoutes: FastifyPluginAsync<OnboardingRoutesOptions> =
	async (fastify, options) => {
		fastify.post(
			"/onboarding/start",
			{ preHandler: fastify.requireAuth },
			async (request, reply) => {
				if (!request.user) {
					return reply.code(401).send({ error: "unauthorized" });
				}

				const body = startBodySchema.safeParse(request.body);

				if (!body.success) {
					return reply.code(400).send({ error: "invalid_onboarding_payload" });
				}

				const result = await startOnboarding(
					options.db,
					options.boss,
					options.config,
					{
						address: request.user.address,
						mockKyc: body.data?.mockKyc,
						userId: request.user.id,
					},
				);

				return reply.code(202).send(result);
			},
		);

		fastify.get(
			"/onboarding/status",
			{ preHandler: fastify.requireAuth },
			async (request, reply) => {
				if (!request.user) {
					return reply.code(401).send({ error: "unauthorized" });
				}

				const onboarding = await getOnboardingForUser(options.db, request.user.id);

				if (!onboarding) {
					return reply.code(404).send({ error: "onboarding_not_started" });
				}

				return reply.send({ onboarding });
			},
		);

		fastify.get(
			"/onboarding/status/stream",
			{ preHandler: fastify.requireAuth },
			async (request, reply) => {
				if (!request.user) {
					return reply.code(401).send({ error: "unauthorized" });
				}

				const initialOnboarding = await getOnboardingForUser(
					options.db,
					request.user.id,
				);

				if (!initialOnboarding) {
					return reply.code(404).send({ error: "onboarding_not_started" });
				}

				reply.hijack();
				reply.raw.writeHead(200, {
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"content-type": "text/event-stream",
				});

				const sendStatus = async (
					knownOnboarding?: Awaited<ReturnType<typeof getOnboardingForUser>>,
				): Promise<boolean> => {
					const onboarding =
						knownOnboarding ??
						(await getOnboardingForUser(options.db, request.user!.id));

					if (!onboarding) {
						reply.raw.write(
							`event: terminal\ndata: ${JSON.stringify({
								error: "onboarding_not_started",
								onboarding: null,
							})}\n\n`,
						);
						return true;
					}

					reply.raw.write(
						`event: status\ndata: ${JSON.stringify({ onboarding })}\n\n`,
					);

					return (
						onboarding?.status === "complete" || onboarding?.status === "failed"
					);
				};

				let closed = false;
				let interval: ReturnType<typeof setInterval> | undefined;
				const clearStatusInterval = (): void => {
					if (interval) {
						clearInterval(interval);
						interval = undefined;
					}
				};
				const close = (): void => {
					if (closed) {
						clearStatusInterval();
						return;
					}

					closed = true;
					clearStatusInterval();
					reply.raw.end();
				};

				request.raw.on("close", () => {
					closed = true;
					clearStatusInterval();
				});

				try {
					if (await sendStatus(initialOnboarding)) {
						close();
						return;
					}

					if (closed) {
						return;
					}

					interval = setInterval(() => {
						void sendStatus()
							.then((done) => {
								if (done) {
									close();
								}
							})
							.catch((error: unknown) => {
								request.log.error({ err: error }, "onboarding sse failed");
								close();
							});
					}, 2_000);
				} catch (error) {
					request.log.error({ err: error }, "onboarding sse failed");
					close();
				}
			},
		);

		fastify.get(
			"/admin/onboardings",
			{ preHandler: fastify.requireRole("network_admin") },
			async (request, reply) => {
				const query = adminOnboardingsQuerySchema.safeParse(request.query);

				if (!query.success) {
					return reply.code(400).send({ error: "invalid_onboarding_query" });
				}

				const result = await listAdminOnboardings(options.db, {
					limit: query.data.limit,
					offset: query.data.offset,
					status: query.data.status as OnboardingStatus | undefined,
				});

				return reply.send(result);
			},
		);
	};
