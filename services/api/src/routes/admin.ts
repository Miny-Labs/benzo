import { and, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type {
	AdminChainClient,
	AllowlistAction,
	AuditorRotationChainResult,
} from "../admin/chain.js";
import {
	createAuditorKeypair,
	parseAuditorPrivateKey,
	publicKeyForPrivateKey,
	type AuditorKeypair,
	type AuditorPublicKey,
} from "../auditor/crypto.js";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { sealString } from "../crypto/seal.js";
import {
	auditLog,
	auditorKeys,
	chainCursor,
	drips,
	events,
	orgTreasuries,
	users,
	type UserRole,
} from "../db/schema.js";
import type { ChainLogSource } from "../indexer/chain.js";

type AdminRoutesOptions = {
	adminChain: AdminChainClient;
	chain: ChainLogSource;
	config: ApiConfig;
	db: Database;
};

const roleBodySchema = z.object({
	action: z.enum(["grant", "revoke"]).default("grant"),
	address: z.string(),
	role: z.enum(["auditor", "network_admin"]),
});

const auditLogQuerySchema = z.object({
	actor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
	offset: z.coerce.number().int().min(0).default(0),
	subject: z.string().optional(),
});

const allowlistBodySchema = z.object({
	action: z.enum(["enable", "revoke"]),
	address: z.string(),
});

const allowlistParamsSchema = z.object({
	address: z.string(),
});

const dripBodySchema = z.object({
	address: z.string(),
	amountWei: z
		.string()
		.regex(/^(0|[1-9][0-9]*)$/)
		.optional(),
});

const auditorRotateBodySchema = z
	.object({
		auditorAddress: z.string().optional(),
		privateKey: z.string().optional(),
	})
	.optional();

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.get(
		"/admin/indexer",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const [latestBlock, cursors, eventCounts] = await Promise.all([
				options.chain.getBlockNumber(),
				options.db
					.select()
					.from(chainCursor)
					.orderBy(desc(chainCursor.updatedAt)),
				options.db
					.select({
						count: count(),
						eventName: events.eventName,
					})
					.from(events)
					.groupBy(events.eventName),
			]);
			const rawConfirmedBlock =
				latestBlock - BigInt(options.config.indexerConfirmations);
			// Clamp at 0 so early-chain heights below the confirmation depth
			// don't report a negative confirmed block (matches the scanner).
			const confirmedBlock =
				rawConfirmedBlock > 0n ? rawConfirmedBlock : 0n;
			const minCursorBlock = cursors.reduce<bigint | null>(
				(minBlock, cursor) =>
					minBlock === null || cursor.lastBlock < minBlock
						? cursor.lastBlock
						: minBlock,
				null,
			);
			const lagBlocks =
				minCursorBlock === null
					? null
					: (confirmedBlock > minCursorBlock
							? confirmedBlock - minCursorBlock
							: 0n
						).toString();
			const [totalEvents] = await options.db
				.select({ count: sql<number>`count(*)::int` })
				.from(events);

			request.log.debug({ latestBlock }, "admin indexer metrics read");

			return reply.send({
				confirmedBlock: confirmedBlock.toString(),
				contracts: cursors.map((cursor) => ({
					contract: cursor.contract,
					lastBlock: cursor.lastBlock.toString(),
					lastBlockHash: cursor.lastBlockHash,
					lastPoll: cursor.updatedAt.toISOString(),
				})),
				eventCounts: Object.fromEntries(
					eventCounts.map((row) => [row.eventName, row.count]),
				),
				lagBlocks,
				lastPoll: cursors[0]?.updatedAt.toISOString() ?? null,
				latestBlock: latestBlock.toString(),
				totalEvents: totalEvents?.count ?? 0,
			});
		},
	);

	fastify.post(
		"/admin/roles",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const body = roleBodySchema.safeParse(request.body);

			if (!body.success || !request.user) {
				return reply.code(400).send({ error: "invalid_role_payload" });
			}

			const address = normalizeAddress(body.data.address);

			if (!address) {
				return reply.code(400).send({ error: "invalid_role_payload" });
			}

			const result = await setUserRole(options.db, {
				action: body.data.action,
				actor: request.user.address,
				address,
				role: body.data.role,
			});

			return reply.send({ user: result });
		},
	);

	fastify.get(
		"/admin/audit-log",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const query = auditLogQuerySchema.safeParse(request.query);

			if (!query.success) {
				return reply.code(400).send({ error: "invalid_audit_log_query" });
			}

			const rows = await options.db
				.select()
				.from(auditLog)
				.where(
					and(
						query.data.actor
							? eq(auditLog.actor, query.data.actor)
							: undefined,
						query.data.subject
							? eq(auditLog.subject, query.data.subject)
							: undefined,
					),
				)
				.orderBy(desc(auditLog.at), desc(auditLog.id))
				.limit(query.data.limit)
				.offset(query.data.offset);

			return reply.send({
				entries: rows.map((row) => ({
					action: row.action,
					actor: row.actor,
					at: row.at.toISOString(),
					id: row.id.toString(),
					meta: row.meta,
					subject: row.subject,
				})),
				limit: query.data.limit,
				offset: query.data.offset,
			});
		},
	);

	fastify.post(
		"/admin/auditor/rotate",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const body = auditorRotateBodySchema.safeParse(request.body);

			if (!body.success || !request.user) {
				return reply.code(400).send({ error: "invalid_auditor_rotate_payload" });
			}

			const auditorAddress = normalizeOptionalAddress(body.data?.auditorAddress);

			if (body.data?.auditorAddress !== undefined && !auditorAddress) {
				return reply.code(400).send({ error: "invalid_auditor_rotate_payload" });
			}

			if (auditorAddress && body.data?.privateKey === undefined) {
				return reply.code(400).send({ error: "invalid_auditor_rotate_payload" });
			}

			let keypair: AuditorKeypair;

			try {
				keypair = createAuditorRotationKeypair(body.data?.privateKey);
			} catch {
				return reply.code(400).send({ error: "invalid_auditor_rotate_payload" });
			}

			let rotation: AuditorRotationChainResult;

			try {
				rotation = await options.adminChain.rotateAuditor({
					auditorAddress,
					publicKey: keypair.publicKey,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "auditor_public_key_mismatch"
				) {
					return reply.code(400).send({ error: "auditor_public_key_mismatch" });
				}

				throw error;
			}

			const actor = request.user.address;
			const [inserted] = await options.db.transaction(async (tx) => {
				await tx
					.update(auditorKeys)
					.set({
						active: false,
						retiredAt: rotation.blockTime,
						retiredBlockNumber: rotation.blockNumber,
						retiredLogIndex: rotation.rotationLogIndex,
						retiredTransactionIndex: rotation.rotationTransactionIndex,
					})
					.where(eq(auditorKeys.active, true));

				const [row] = await tx
					.insert(auditorKeys)
					.values({
						activatedAt: rotation.blockTime,
						activatedBlockNumber: rotation.blockNumber,
						activatedLogIndex: rotation.rotationLogIndex,
						activatedTransactionIndex: rotation.rotationTransactionIndex,
						active: true,
						publicKeyX: keypair.publicKey[0],
						publicKeyY: keypair.publicKey[1],
						rotationTxHash: rotation.txHash,
						sealedKey: sealString(options.config.appMasterKey, keypair.privateKey),
					})
					.returning({
						id: auditorKeys.id,
					});

				await tx.insert(auditLog).values({
					action: "auditor_rotate",
					actor,
					meta: {
						activatedBlockNumber: rotation.blockNumber.toString(),
						auditorAddress: rotation.auditorAddress,
						auditorKeyId: row?.id,
						publicKey: keypair.publicKey,
						rotationLogIndex: rotation.rotationLogIndex,
						rotationTransactionIndex: rotation.rotationTransactionIndex,
						txHash: rotation.txHash,
					},
					subject: "auditor_keys",
				});

				return [row];
			});

			return reply.code(201).send({
				auditorKey: {
					activatedBlockNumber: rotation.blockNumber.toString(),
					id: inserted?.id,
					publicKey: keypair.publicKey,
					txHash: rotation.txHash,
				},
			});
		},
	);

	fastify.post(
		"/admin/allowlist",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const body = allowlistBodySchema.safeParse(request.body);

			if (!body.success || !request.user) {
				return reply.code(400).send({ error: "invalid_allowlist_payload" });
			}

			const address = normalizeAddress(body.data.address);

			if (!address) {
				return reply.code(400).send({ error: "invalid_allowlist_payload" });
			}

			const result = await options.adminChain.applyAllowlist(
				address,
				body.data.action as AllowlistAction,
			);
			await options.db.insert(auditLog).values({
				action: `allowlist_${body.data.action}`,
				actor: request.user.address,
				meta: result,
				subject: address,
			});

			return reply.send({ allowlist: result });
		},
	);

	fastify.get(
		"/admin/allowlist/:address",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const params = allowlistParamsSchema.safeParse(request.params);

			if (!params.success) {
				return reply.code(400).send({ error: "invalid_allowlist_query" });
			}

			const address = normalizeAddress(params.data.address);

			if (!address) {
				return reply.code(400).send({ error: "invalid_allowlist_query" });
			}

			return reply.send({
				allowlist: await options.adminChain.getAllowlistStatus(address),
			});
		},
	);

	fastify.post(
		"/admin/drip",
		{ preHandler: fastify.requireRole("network_admin") },
		async (request, reply) => {
			const body = dripBodySchema.safeParse(request.body);

			if (!body.success || !request.user) {
				return reply.code(400).send({ error: "invalid_drip_payload" });
			}

			const address = normalizeAddress(body.data.address);

			if (!address) {
				return reply.code(400).send({ error: "invalid_drip_payload" });
			}

			const amountWei =
				body.data.amountWei === undefined
					? options.config.dripWei
					: BigInt(body.data.amountWei);
			const result = await options.adminChain.dripGas(address, amountWei);
			const actor = request.user.address;

			await options.db.transaction(async (tx) => {
				const [user] = await tx
					.insert(users)
					.values({ address })
					.onConflictDoUpdate({
						set: { address },
						target: users.address,
					})
					.returning({ id: users.id });

				if (!user) {
					throw new Error("admin_drip_user_upsert_failed");
				}

				await tx.insert(drips).values({
					address,
					amountWei: result.amountWei,
					chainEnv: options.config.chainEnv,
					chainId: options.config.benzonetChainId,
					mode: `admin_${result.mode}`,
					txHash: result.txHash,
					userId: user.id,
				});
				await tx.insert(auditLog).values({
					action: "admin_drip",
					actor,
					meta: result,
					subject: address,
				});
			});

			return reply.send({ drip: result });
		},
	);

	fastify.get(
		"/admin/chain",
		{ preHandler: fastify.requireRole("network_admin") },
		async (_request, reply) => {
			const treasuries = await options.db
				.select({ address: orgTreasuries.address })
				.from(orgTreasuries);
			const [health, cursors] = await Promise.all([
				options.adminChain.getChainHealth(
					treasuries.map((treasury) => treasury.address),
				),
				options.db
					.select()
					.from(chainCursor)
					.orderBy(desc(chainCursor.updatedAt)),
			]);
			const confirmedBlock = maxBigint(
				BigInt(health.latestBlock) - BigInt(options.config.indexerConfirmations),
				0n,
			);
			const minCursorBlock = cursors.reduce<bigint | null>(
				(minBlock, cursor) =>
					minBlock === null || cursor.lastBlock < minBlock
						? cursor.lastBlock
						: minBlock,
				null,
			);

			return reply.send({
				...health,
				indexer: {
					confirmedBlock: confirmedBlock.toString(),
					contracts: cursors.map((cursor) => ({
						contract: cursor.contract,
						lastBlock: cursor.lastBlock.toString(),
						lastBlockHash: cursor.lastBlockHash,
						lastPoll: cursor.updatedAt.toISOString(),
					})),
					lagBlocks:
						minCursorBlock === null
							? null
							: maxBigint(confirmedBlock - minCursorBlock, 0n).toString(),
					lastPoll: cursors[0]?.updatedAt.toISOString() ?? null,
				},
			});
		},
	);
};

async function setUserRole(
	db: Database,
	input: {
		action: "grant" | "revoke";
		actor: string;
		address: string;
		role: UserRole;
	},
): Promise<{ address: string; roles: UserRole[] }> {
	return db.transaction(async (tx) => {
		const [user] = await tx
			.insert(users)
			.values({
				address: input.address,
			})
			.onConflictDoUpdate({
				set: { address: input.address },
				target: users.address,
			})
			.returning({
				address: users.address,
				roles: users.roles,
			});

		if (!user) {
			throw new Error("role_user_upsert_failed");
		}

		const roles =
			input.action === "grant"
				? [...new Set([...user.roles, input.role])]
				: user.roles.filter((role) => role !== input.role);
		const [updated] = await tx
			.update(users)
			.set({ roles })
			.where(eq(users.address, input.address))
			.returning({
				address: users.address,
				roles: users.roles,
			});

		if (!updated) {
			throw new Error("role_user_update_failed");
		}

		await tx.insert(auditLog).values({
			action: `role_${input.action}`,
			actor: input.actor,
			meta: {
				role: input.role,
				roles,
			},
			subject: input.address,
		});

		return updated;
	});
}

function normalizeAddress(address: string): string | null {
	if (!isAddress(address, { strict: false })) {
		return null;
	}

	return getAddress(address).toLowerCase();
}

function normalizeOptionalAddress(address: string | undefined): string | undefined {
	if (address === undefined) {
		return undefined;
	}

	return normalizeAddress(address) ?? undefined;
}

function createAuditorRotationKeypair(privateKey: string | undefined): AuditorKeypair {
	if (privateKey === undefined) {
		return createAuditorKeypair();
	}

	const keypair = createAuditorKeypair(parseAuditorPrivateKey(privateKey));
	const publicKey = publicKeyForPrivateKey(privateKey);

	if (!auditorPublicKeysEqual(publicKey, keypair.publicKey)) {
		throw new Error("invalid_auditor_private_key");
	}

	return keypair;
}

function auditorPublicKeysEqual(
	left: AuditorPublicKey,
	right: AuditorPublicKey,
): boolean {
	return left[0] === right[0] && left[1] === right[1];
}

function maxBigint(a: bigint, b: bigint): bigint {
	return a > b ? a : b;
}
