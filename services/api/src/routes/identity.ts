import { createHash } from "node:crypto";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { Database } from "../db/client.js";
import {
	contacts,
	handles,
	invites,
	type InviteKind,
	users,
} from "../db/schema.js";
import {
	AddressAlreadyHasHandleError,
	HandleTakenError,
	type IdentityChainClient,
} from "../identity/chain.js";
import { createInviteToken, hashInviteToken } from "../identity/invites.js";
import type { OnboardingOrchestrator } from "../identity/onboarding.js";

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
const RESERVED_HANDLES = new Set([
	"admin",
	"api",
	"auditor",
	"auth",
	"benzo",
	"contact",
	"contacts",
	"gift",
	"gifts",
	"healthz",
	"invite",
	"invites",
	"null",
	"owner",
	"pay",
	"payments",
	"resolve",
	"root",
	"security",
	"support",
	"system",
	"undefined",
	"wallet",
]);
const DEFAULT_INVITE_TTL_MS = 7 * 86_400_000;

const handleBodySchema = z.object({
	handle: z.string().trim(),
});

const handleParamSchema = z.object({
	handle: z.string().trim(),
});

const contactBodySchema = z.object({
	alias: z.string().trim().min(1).max(80).nullable().optional(),
	contactAddress: z.string().refine((value) => isAddress(value, { strict: false })),
	favorite: z.boolean().optional(),
});

const contactParamSchema = z.object({
	address: z.string().refine((value) => isAddress(value, { strict: false })),
});

const contactPatchBodySchema = z
	.object({
		alias: z.string().trim().min(1).max(80).nullable().optional(),
		favorite: z.boolean().optional(),
	})
	.refine((value) => value.alias !== undefined || value.favorite !== undefined);

const decimalAmountSchema = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;

const inviteBodySchema = z.object({
	expiresAt: z.string().trim().optional(),
	giftAmount: z.string().trim().regex(decimalAmountSchema).nullable().optional(),
	kind: z.enum(["invite", "gift"]).default("invite"),
	note: z.string().trim().min(1).max(280).nullable().optional(),
});

const inviteTokenParamSchema = z.object({
	token: z.string().min(16).max(256),
});

type IdentityRoutesOptions = {
	db: Database;
	identityChain: IdentityChainClient;
	onboarding: OnboardingOrchestrator;
};

export const identityRoutes: FastifyPluginAsync<IdentityRoutesOptions> = async (
	fastify,
	options,
) => {
	const handleClaimLimit = fastify.rateLimit({
		keyGenerator: userRateLimitKey("handle-claim"),
		max: 3,
		timeWindow: "1 day",
	});
	const inviteCreateLimit = fastify.rateLimit({
		keyGenerator: userRateLimitKey("invite-create"),
		max: 20,
		timeWindow: "1 day",
	});

	fastify.post(
		"/handles",
		{ preHandler: [fastify.requireAuth, handleClaimLimit] },
		async (request, reply) => {
			const body = handleBodySchema.safeParse(request.body);

			if (!body.success) {
				return reply.code(400).send({ error: "invalid_handle" });
			}

			const handleResult = parseHandle(body.data.handle);

			if (!handleResult.ok) {
				return reply.code(400).send({ error: handleResult.error });
			}

			const user = requireUser(request);

			try {
				const claimed = await options.identityChain.claimHandle({
					handle: handleResult.handle,
					ownerAddress: user.address,
				});

				if (claimed.address.toLowerCase() !== user.address) {
					return reply.code(409).send({ error: "handle_claim_owner_mismatch" });
				}

				await mirrorHandle(options.db, handleResult.handle, claimed.address);

				return reply.code(201).send({
					address: claimed.address,
					handle: handleResult.handle,
					registeredOnEerc: claimed.registeredOnEerc,
					source: claimed.source,
				});
			} catch (error) {
				if (error instanceof HandleTakenError) {
					return reply.code(409).send({ error: "handle_taken" });
				}

				if (error instanceof AddressAlreadyHasHandleError) {
					return reply.code(409).send({ error: "address_already_has_handle" });
				}

				throw error;
			}
		},
	);

	fastify.get("/resolve/:handle", async (request, reply) => {
		const params = handleParamSchema.safeParse(request.params);

		if (!params.success) {
			return reply.code(400).send({ error: "invalid_handle" });
		}

		const handleResult = parseHandle(params.data.handle);

		if (!handleResult.ok) {
			return reply.code(400).send({ error: handleResult.error });
		}

		const cached = await readCachedHandle(options.db, handleResult.handle);

		try {
			const chainResolution = await options.identityChain.resolveHandle(
				handleResult.handle,
			);

			if (!chainResolution.address) {
				await removeCachedHandle(options.db, handleResult.handle);
				return sendCachedResponse(reply, request, 404, {
					error: "handle_not_found",
					source: chainResolution.source,
				});
			}

			if (cached?.address !== chainResolution.address) {
				await mirrorHandle(
					options.db,
					handleResult.handle,
					chainResolution.address,
				);
			}

			return sendCachedResponse(reply, request, 200, {
				address: chainResolution.address,
				registeredOnEerc: chainResolution.registeredOnEerc,
				source: chainResolution.source,
			});
		} catch (error) {
			request.log.warn({ err: error }, "chain handle resolution failed");

			if (!cached) {
				throw error;
			}

			const [registered] = await registrationMap(options.identityChain, [
				cached.address,
			]);

			return sendCachedResponse(reply, request, 200, {
				address: cached.address,
				registeredOnEerc: registered?.registeredOnEerc ?? false,
				source: "cache",
			});
		}
	});

	fastify.get(
		"/contacts",
		{ preHandler: fastify.requireAuth },
		async (request) => {
			const user = requireUser(request);
			const contactUser = pgAlias(users, "contact_user");
			const rows = await options.db
				.select({
					address: contacts.contactAddress,
					alias: contacts.alias,
					favorite: contacts.favorite,
					handle: handles.handle,
				})
				.from(contacts)
				.leftJoin(contactUser, eq(contactUser.address, contacts.contactAddress))
				.leftJoin(handles, eq(handles.userId, contactUser.id))
				.where(eq(contacts.ownerUserId, user.id))
				.orderBy(sql`${contacts.favorite} desc`, contacts.alias, contacts.contactAddress);
			const registrations = await options.identityChain.getRegistrationStatuses(
				rows.map((row) => row.address),
			);

			return {
				contacts: rows.map((row) => ({
					address: row.address,
					alias: row.alias,
					favorite: row.favorite,
					handle: row.handle,
					registeredOnEerc: registrations.get(row.address) ?? false,
				})),
			};
		},
	);

	fastify.post(
		"/contacts",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const body = contactBodySchema.safeParse(request.body);

			if (!body.success) {
				return reply.code(400).send({ error: "invalid_contact" });
			}

			const user = requireUser(request);
			const contactAddress = normalizeAddress(body.data.contactAddress);
			const [row] = await options.db
				.insert(contacts)
				.values({
					alias: body.data.alias ?? null,
					contactAddress,
					favorite: body.data.favorite ?? false,
					ownerUserId: user.id,
				})
				.onConflictDoNothing({
					target: [contacts.ownerUserId, contacts.contactAddress],
				})
				.returning({
					address: contacts.contactAddress,
					alias: contacts.alias,
					favorite: contacts.favorite,
				});

			if (!row) {
				return reply.code(409).send({ error: "contact_exists" });
			}

			const [registration] = await registrationMap(options.identityChain, [
				row.address,
			]);

			return reply.code(201).send({
				contact: {
					...row,
					handle: await getHandleForAddress(options.db, row.address),
					registeredOnEerc: registration?.registeredOnEerc ?? false,
				},
			});
		},
	);

	fastify.patch(
		"/contacts/:address",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const params = contactParamSchema.safeParse(request.params);
			const body = contactPatchBodySchema.safeParse(request.body);

			if (!params.success || !body.success) {
				return reply.code(400).send({ error: "invalid_contact" });
			}

			const user = requireUser(request);
			const contactAddress = normalizeAddress(params.data.address);
			const [row] = await options.db
				.update(contacts)
				.set({
					...(body.data.alias !== undefined ? { alias: body.data.alias } : {}),
					...(body.data.favorite !== undefined
						? { favorite: body.data.favorite }
						: {}),
				})
				.where(
					and(
						eq(contacts.ownerUserId, user.id),
						eq(contacts.contactAddress, contactAddress),
					),
				)
				.returning({
					address: contacts.contactAddress,
					alias: contacts.alias,
					favorite: contacts.favorite,
				});

			if (!row) {
				return reply.code(404).send({ error: "contact_not_found" });
			}

			const [registration] = await registrationMap(options.identityChain, [
				row.address,
			]);

			return {
				contact: {
					...row,
					handle: await getHandleForAddress(options.db, row.address),
					registeredOnEerc: registration?.registeredOnEerc ?? false,
				},
			};
		},
	);

	fastify.delete(
		"/contacts/:address",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const params = contactParamSchema.safeParse(request.params);

			if (!params.success) {
				return reply.code(400).send({ error: "invalid_contact" });
			}

			const user = requireUser(request);
			const contactAddress = normalizeAddress(params.data.address);
			const [row] = await options.db
				.delete(contacts)
				.where(
					and(
						eq(contacts.ownerUserId, user.id),
						eq(contacts.contactAddress, contactAddress),
					),
				)
				.returning({ address: contacts.contactAddress });

			if (!row) {
				return reply.code(404).send({ error: "contact_not_found" });
			}

			return reply.code(204).send();
		},
	);

	fastify.post(
		"/invites",
		{ preHandler: [fastify.requireAuth, inviteCreateLimit] },
		async (request, reply) => {
			const body = inviteBodySchema.safeParse(request.body);

			if (!body.success) {
				return reply.code(400).send({ error: "invalid_invite" });
			}

			const expiresAt = parseInviteExpiry(body.data.expiresAt);

			if (!expiresAt || expiresAt <= new Date()) {
				return reply.code(400).send({ error: "invalid_invite_expiry" });
			}

			const user = requireUser(request);
			const token = createInviteToken();
			const tokenHash = hashInviteToken(token);
			const [row] = await options.db
				.insert(invites)
				.values({
					creatorUserId: user.id,
					expiresAt,
					giftAmount: body.data.giftAmount ?? null,
					kind: body.data.kind,
					note: body.data.note ?? null,
					tokenHash,
				})
				.returning({
					expiresAt: invites.expiresAt,
					id: invites.id,
					kind: invites.kind,
					note: invites.note,
					status: invites.status,
				});

			return reply.code(201).send({
				invite: {
					expiresAt: row.expiresAt.toISOString(),
					id: row.id,
					kind: row.kind,
					note: row.note,
					status: row.status,
				},
				token,
			});
		},
	);

	fastify.get("/invites/:token", async (request, reply) => {
		const params = inviteTokenParamSchema.safeParse(request.params);

		if (!params.success) {
			return reply.code(404).send({ error: "invite_not_found" });
		}

		const row = await findInviteForToken(options.db, params.data.token);

		if (!row) {
			return reply.code(404).send({ error: "invite_not_found" });
		}

		const unavailable = await ensureInviteAvailable(options.db, row);

		if (unavailable) {
			return reply.code(unavailable.statusCode).send({ error: unavailable.error });
		}

		return {
			invite: publicInvite(row),
		};
	});

	fastify.post(
		"/invites/:token/claim",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const params = inviteTokenParamSchema.safeParse(request.params);

			if (!params.success) {
				return reply.code(404).send({ error: "invite_not_found" });
			}

			const user = requireUser(request);
			const tokenHash = hashInviteToken(params.data.token);
			const now = new Date();
			const claimed = await options.db.transaction(async (tx) => {
				const [row] = await tx
					.update(invites)
					.set({
						claimedBy: user.id,
						status: "claimed",
					})
					.where(
						and(
							eq(invites.tokenHash, tokenHash),
							eq(invites.status, "created"),
							gt(invites.expiresAt, now),
						),
					)
					.returning({
						creatorUserId: invites.creatorUserId,
						expiresAt: invites.expiresAt,
						id: invites.id,
						kind: invites.kind,
						note: invites.note,
						status: invites.status,
					});

				return row ?? null;
			});

			if (!claimed) {
				const row = await findInviteForToken(options.db, params.data.token);

				if (!row) {
					return reply.code(404).send({ error: "invite_not_found" });
				}

				const unavailable = await ensureInviteAvailable(options.db, row);
				return reply
					.code(unavailable?.statusCode ?? 409)
					.send({ error: unavailable?.error ?? "invite_already_claimed" });
			}

			await options.onboarding.startForInviteClaim({
				address: user.address,
				inviteId: claimed.id,
				userId: user.id,
			});

			const [registration] = await registrationMap(options.identityChain, [
				user.address,
			]);
			const [creator] = await options.db
				.select({
					creatorHandle: handles.handle,
				})
				.from(users)
				.leftJoin(handles, eq(handles.userId, users.id))
				.where(eq(users.id, claimed.creatorUserId))
				.limit(1);

			return {
				claimant: {
					address: user.address,
					registeredOnEerc: registration?.registeredOnEerc ?? false,
				},
				invite: {
					creatorHandle: creator?.creatorHandle ?? null,
					expiresAt: claimed.expiresAt.toISOString(),
					kind: claimed.kind,
					note: claimed.note,
					status: claimed.status,
				},
			};
		},
	);
};

function userRateLimitKey(group: string) {
	return (request: FastifyRequest) => {
		const userId = request.user?.id ?? "anonymous";
		return `${group}:${userId}`;
	};
}

function requireUser(request: FastifyRequest) {
	if (!request.user) {
		throw new Error("authenticated user missing after requireAuth");
	}

	return request.user;
}

function parseHandle(
	value: string,
):
	| { handle: string; ok: true }
	| { error: "invalid_handle" | "reserved_handle"; ok: false } {
	if (!HANDLE_PATTERN.test(value)) {
		return { error: "invalid_handle", ok: false };
	}

	if (RESERVED_HANDLES.has(value)) {
		return { error: "reserved_handle", ok: false };
	}

	return { handle: value, ok: true };
}

function normalizeAddress(address: string): string {
	return getAddress(address).toLowerCase();
}

async function mirrorHandle(
	db: Database,
	handle: string,
	address: string,
): Promise<void> {
	const normalizedAddress = normalizeAddress(address);

	await db.transaction(async (tx) => {
		const [insertedUser] = await tx
			.insert(users)
			.values({
				address: normalizedAddress,
			})
			.onConflictDoNothing({ target: users.address })
			.returning({
				id: users.id,
			});
		const [existingUser] =
			insertedUser === undefined
				? await tx
						.select({ id: users.id })
						.from(users)
						.where(eq(users.address, normalizedAddress))
						.limit(1)
				: [];
		const user = insertedUser ?? existingUser;

		if (!user) {
			throw new Error("handle owner lookup failed");
		}

		await tx
			.delete(handles)
			.where(or(eq(handles.handle, handle), eq(handles.userId, user.id)));
		await tx.insert(handles).values({
			handle,
			userId: user.id,
		});
	});
}

async function removeCachedHandle(db: Database, handle: string): Promise<void> {
	await db.delete(handles).where(eq(handles.handle, handle));
}

async function readCachedHandle(
	db: Database,
	handle: string,
): Promise<{ address: string } | null> {
	const [row] = await db
		.select({
			address: users.address,
		})
		.from(handles)
		.innerJoin(users, eq(users.id, handles.userId))
		.where(eq(handles.handle, handle))
		.limit(1);

	return row ?? null;
}

async function getHandleForAddress(
	db: Database,
	address: string,
): Promise<string | null> {
	const [row] = await db
		.select({ handle: handles.handle })
		.from(users)
		.innerJoin(handles, eq(handles.userId, users.id))
		.where(eq(users.address, address))
		.limit(1);

	return row?.handle ?? null;
}

async function registrationMap(
	identityChain: IdentityChainClient,
	addresses: string[],
): Promise<Array<{ address: string; registeredOnEerc: boolean }>> {
	const statuses = await identityChain.getRegistrationStatuses(addresses);
	return addresses.map((address) => ({
		address,
		registeredOnEerc: statuses.get(address.toLowerCase()) ?? false,
	}));
}

function parseInviteExpiry(value: string | undefined): Date | null {
	if (!value) {
		return new Date(Date.now() + DEFAULT_INVITE_TTL_MS);
	}

	const expiresAt = new Date(value);
	return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
}

async function findInviteForToken(
	db: Database,
	token: string,
): Promise<{
	creatorHandle: string | null;
	expiresAt: Date;
	id: string;
	kind: InviteKind;
	note: string | null;
	status: string;
} | null> {
	const creator = pgAlias(users, "creator");
	const [row] = await db
		.select({
			creatorHandle: handles.handle,
			expiresAt: invites.expiresAt,
			id: invites.id,
			kind: invites.kind,
			note: invites.note,
			status: invites.status,
		})
		.from(invites)
		.innerJoin(creator, eq(creator.id, invites.creatorUserId))
		.leftJoin(handles, eq(handles.userId, creator.id))
		.where(eq(invites.tokenHash, hashInviteToken(token)))
		.limit(1);

	return row ?? null;
}

async function ensureInviteAvailable(
	db: Database,
	invite: { expiresAt: Date; id: string; status: string },
): Promise<{ error: string; statusCode: 409 | 410 } | null> {
	if (invite.status !== "created") {
		return {
			error: `invite_${invite.status}`,
			statusCode: invite.status === "expired" ? 410 : 409,
		};
	}

	if (invite.expiresAt > new Date()) {
		return null;
	}

	await db
		.update(invites)
		.set({ status: "expired" })
		.where(
			and(
				eq(invites.id, invite.id),
				eq(invites.status, "created"),
				lte(invites.expiresAt, new Date()),
			),
		);

	return { error: "invite_expired", statusCode: 410 };
}

function publicInvite(invite: {
	creatorHandle: string | null;
	expiresAt: Date;
	kind: InviteKind;
	note: string | null;
	status: string;
}) {
	return {
		creatorHandle: invite.creatorHandle,
		expiresAt: invite.expiresAt.toISOString(),
		kind: invite.kind,
		note: invite.note,
		status: invite.status,
	};
}

function sendCachedResponse(
	reply: FastifyReply,
	request: FastifyRequest,
	statusCode: number,
	payload: unknown,
) {
	const etag = createEtag(payload);
	reply.header("Cache-Control", "public, max-age=60");
	reply.header("ETag", etag);

	if (request.headers["if-none-match"] === etag) {
		return reply.code(304).send();
	}

	return reply.code(statusCode).send(payload);
}

function createEtag(payload: unknown): string {
	const body = JSON.stringify(payload);
	return `"${createHash("sha256").update(body).digest("base64url")}"`;
}
