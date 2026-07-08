import type {
	FastifyPluginAsync,
	preHandlerAsyncHookHandler,
} from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import {
	buildAuditorPacket,
	buildAuditorReport,
	exportAuditorReportCsv,
	listAuditorEvents,
} from "../auditor/service.js";

type AuditorRoutesOptions = {
	config: ApiConfig;
	db: Database;
};

const eventQuerySchema = z.object({
	address: z.string().optional(),
	from: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	to: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
});

const reportParamsSchema = z.object({
	address: z.string(),
});

const reportQuerySchema = z.object({
	from: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
	to: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
});

const packetBodySchema = z.object({
	address: z.string(),
	fromBlock: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
	toBlock: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
});

export const auditorRoutes: FastifyPluginAsync<AuditorRoutesOptions> = async (
	fastify,
	options,
) => {
	const requireAuditor = buildRequireAuditor(options.db);

	fastify.get(
		"/auditor/events",
		{ preHandler: requireAuditor },
		async (request, reply) => {
			const query = eventQuerySchema.safeParse(request.query);

			if (!query.success || !request.user) {
				return reply.code(400).send({ error: "invalid_auditor_query" });
			}

			const address = normalizeOptionalAddress(query.data.address);

			if (query.data.address && !address) {
				return reply.code(400).send({ error: "invalid_auditor_query" });
			}

			try {
				return reply.send(
					await listAuditorEvents(options.db, options.config, {
						actor: request.user.address,
						address,
						fromBlock:
							query.data.from === undefined ? undefined : BigInt(query.data.from),
						limit: query.data.limit,
						offset: query.data.offset,
						toBlock:
							query.data.to === undefined ? undefined : BigInt(query.data.to),
					}),
				);
			} catch (error) {
				if (isMissingAuditorKeyError(error)) {
					return reply.code(409).send({ error: "auditor_key_missing" });
				}

				throw error;
			}
		},
	);

	fastify.get(
		"/auditor/report/:address",
		{ preHandler: requireAuditor },
		async (request, reply) => {
			const params = reportParamsSchema.safeParse(request.params);
			const query = reportQuerySchema.safeParse(request.query);

			if (!params.success || !query.success || !request.user) {
				return reply.code(400).send({ error: "invalid_auditor_report_query" });
			}

			const address = normalizeOptionalAddress(params.data.address);

			if (!address) {
				return reply.code(400).send({ error: "invalid_auditor_report_query" });
			}

			try {
				return reply.send({
					report: await buildAuditorReport(options.db, options.config, {
						actor: request.user.address,
						address,
						fromBlock:
							query.data.from === undefined ? undefined : BigInt(query.data.from),
						toBlock:
							query.data.to === undefined ? undefined : BigInt(query.data.to),
					}),
				});
			} catch (error) {
				if (isMissingAuditorKeyError(error)) {
					return reply.code(409).send({ error: "auditor_key_missing" });
				}

				throw error;
			}
		},
	);

	fastify.get(
		"/auditor/report/:address/export",
		{ preHandler: requireAuditor },
		async (request, reply) => {
			const params = reportParamsSchema.safeParse(request.params);
			const query = reportQuerySchema.safeParse(request.query);

			if (!params.success || !query.success || !request.user) {
				return reply
					.code(400)
					.send({ error: "invalid_auditor_report_export_query" });
			}

			const address = normalizeOptionalAddress(params.data.address);

			if (!address) {
				return reply
					.code(400)
					.send({ error: "invalid_auditor_report_export_query" });
			}

			try {
				const exportResult = await exportAuditorReportCsv(
					options.db,
					options.config,
					{
						actor: request.user.address,
						address,
						fromBlock:
							query.data.from === undefined ? undefined : BigInt(query.data.from),
						toBlock:
							query.data.to === undefined ? undefined : BigInt(query.data.to),
					},
				);

				return reply
					.header("content-type", "text/csv; charset=utf-8")
					.header(
						"content-disposition",
						`attachment; filename="${auditDownloadName(
							"auditor-report",
							address,
							exportResult.report.fromBlock,
							exportResult.report.toBlock,
							"csv",
						)}"`,
					)
					.send(exportResult.csv);
			} catch (error) {
				if (isMissingAuditorKeyError(error)) {
					return reply.code(409).send({ error: "auditor_key_missing" });
				}

				throw error;
			}
		},
	);

	fastify.post(
		"/auditor/packet",
		{ preHandler: requireAuditor },
		async (request, reply) => {
			const body = packetBodySchema.safeParse(request.body);

			if (!body.success || !request.user) {
				return reply.code(400).send({ error: "invalid_auditor_packet_payload" });
			}

			const address = normalizeOptionalAddress(body.data.address);

			if (!address) {
				return reply.code(400).send({ error: "invalid_auditor_packet_payload" });
			}

			try {
				const packet = await buildAuditorPacket(options.db, options.config, {
					actor: request.user.address,
					address,
					fromBlock:
						body.data.fromBlock === undefined
							? undefined
							: BigInt(body.data.fromBlock),
					toBlock:
						body.data.toBlock === undefined ? undefined : BigInt(body.data.toBlock),
				});

				return reply
					.header(
						"content-disposition",
						`attachment; filename="${auditDownloadName(
							"auditor-packet",
							address,
							packet.fromBlock,
							packet.toBlock,
							"json",
						)}"`,
					)
					.send(packet);
			} catch (error) {
				if (isMissingAuditorKeyError(error)) {
					return reply.code(409).send({ error: "auditor_key_missing" });
				}

				throw error;
			}
		},
	);
};

function buildRequireAuditor(db: Database): preHandlerAsyncHookHandler {
	return async function requireAuditor(request, reply) {
		await this.requireAuth(request, reply);

		if (reply.sent) {
			return;
		}

		if (request.user?.roles.includes("auditor")) {
			return;
		}

		await db.insert(auditLog).values({
			action: "auditor_access_denied",
			actor: request.user?.address ?? "anonymous",
			meta: {
				method: request.method,
				path: request.url,
			},
			subject: request.user?.address ?? "anonymous",
		});
		await reply.code(403).send({ error: "forbidden" });
	};
}

function normalizeOptionalAddress(address: string | undefined): string | undefined {
	if (address === undefined) {
		return undefined;
	}

	if (!isAddress(address, { strict: false })) {
		return undefined;
	}

	return getAddress(address).toLowerCase();
}

function isMissingAuditorKeyError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("auditor_key_missing");
}

function auditDownloadName(
	prefix: string,
	address: string,
	fromBlock: string | null,
	toBlock: string | null,
	extension: "csv" | "json",
): string {
	return `${prefix}-${address}-${fromBlock ?? "start"}-${toBlock ?? "latest"}.${extension}`;
}
