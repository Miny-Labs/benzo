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

const statusQuerySchema = z.object({
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

				reply.hijack();
				reply.raw.writeHead(200, {
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"content-type": "text/event-stream",
				});

				const sendStatus = async (): Promise<boolean> => {
					const onboarding = await getOnboardingForUser(
						options.db,
						request.user!.id,
					);

					reply.raw.write(
						`event: status\ndata: ${JSON.stringify({ onboarding })}\n\n`,
					);

					return (
						onboarding?.status === "complete" || onboarding?.status === "failed"
					);
				};

				const close = (): void => {
					clearInterval(interval);
					reply.raw.end();
				};
				const interval = setInterval(() => {
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

				request.raw.on("close", () => {
					clearInterval(interval);
				});

				try {
					if (await sendStatus()) {
						close();
					}
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
				const query = statusQuerySchema.safeParse(request.query);

				if (!query.success) {
					return reply.code(400).send({ error: "invalid_status_filter" });
				}

				const onboardings = await listAdminOnboardings(
					options.db,
					query.data.status as OnboardingStatus | undefined,
				);

				return reply.send({ onboardings });
			},
		);
	};
