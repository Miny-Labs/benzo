import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { sealString } from "../crypto/seal.js";
import {
	orgMembers,
	orgTreasuries,
	orgs,
	type OrgRole,
} from "../db/schema.js";

declare module "fastify" {
	interface FastifyRequest {
		orgRole?: OrgRole;
	}
}

type OrgsRoutesOptions = {
	config: ApiConfig;
	db: Database;
};

// Role hierarchy: a higher rank implies every capability of the ranks below it.
const ROLE_RANK: Record<OrgRole, number> = {
	viewer: 0,
	operator: 1,
	admin: 2,
	owner: 3,
};

const createOrgSchema = z.object({
	name: z.string().trim().min(1).max(120),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(60)
		.regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric or hyphen"),
});

const addMemberSchema = z.object({
	address: z.string().trim().toLowerCase(),
	role: z.enum(["admin", "operator", "viewer"]),
});

const provisionTreasurySchema = z.object({
	// Managed-treasury custody is an explicit consent moment: the caller must
	// acknowledge that Benzo will hold this treasury key on its servers.
	consent: z.literal(true),
});

const evmAddress = /^0x[0-9a-fA-F]{40}$/;

export const orgsRoutes: FastifyPluginAsync<OrgsRoutesOptions> = async (
	fastify,
	options,
) => {
	const { db } = options;

	// Resolve the caller's membership role for the :id org, or null if not a
	// member. request.user is guaranteed by requireAuth running first.
	const loadMembership = async (
		orgId: string,
		userId: string,
	): Promise<OrgRole | null> => {
		const [member] = await db
			.select({ role: orgMembers.role })
			.from(orgMembers)
			.where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
			.limit(1);
		return member?.role ?? null;
	};

	// Gate an org-scoped route on a minimum role. 404 (not 403) when the caller
	// isn't a member so org existence isn't leaked to non-members.
	const requireOrgRole =
		(minRole: OrgRole): preHandlerAsyncHookHandler =>
		async (request, reply) => {
			await fastify.requireAuth.call(fastify, request, reply);
			if (reply.sent) {
				return;
			}

			const orgId = (request.params as { id: string }).id;
			if (!z.uuid().safeParse(orgId).success) {
				await reply.code(400).send({ error: "invalid_org_id" });
				return;
			}

			const role = await loadMembership(orgId, request.user!.id);
			if (role === null) {
				await reply.code(404).send({ error: "org_not_found" });
				return;
			}
			if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
				await reply.code(403).send({ error: "forbidden" });
				return;
			}

			request.orgRole = role;
		};

	// POST /orgs — create an org; the creator becomes its owner.
	fastify.post("/orgs", { preHandler: fastify.requireAuth }, async (request, reply) => {
		const body = createOrgSchema.safeParse(request.body);
		if (!body.success) {
			return reply.code(400).send({ error: "invalid_org" });
		}

		const userId = request.user!.id;
		const created = await db.transaction(async (tx) => {
			const [org] = await tx
				.insert(orgs)
				.values({ name: body.data.name, slug: body.data.slug })
				.returning();
			await tx
				.insert(orgMembers)
				.values({ orgId: org!.id, userId, role: "owner" });
			return org;
		});

		return reply.code(201).send({ org: created, role: "owner" });
	});

	// GET /orgs — orgs the caller belongs to, with their role in each.
	fastify.get("/orgs", { preHandler: fastify.requireAuth }, async (request, reply) => {
		const userId = request.user!.id;
		const rows = await db
			.select({
				id: orgs.id,
				name: orgs.name,
				slug: orgs.slug,
				role: orgMembers.role,
				createdAt: orgs.createdAt,
			})
			.from(orgMembers)
			.innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
			.where(eq(orgMembers.userId, userId));
		return reply.send({ orgs: rows });
	});

	// GET /orgs/:id — org detail; any member may read.
	fastify.get(
		"/orgs/:id",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const [org] = await db
				.select()
				.from(orgs)
				.where(eq(orgs.id, orgId))
				.limit(1);
			return reply.send({ org, role: request.orgRole });
		},
	);

	// GET /orgs/:id/members — any member may list.
	fastify.get(
		"/orgs/:id/members",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const members = await db
				.select({
					userId: orgMembers.userId,
					role: orgMembers.role,
					createdAt: orgMembers.createdAt,
				})
				.from(orgMembers)
				.where(eq(orgMembers.orgId, orgId));
			return reply.send({ members });
		},
	);

	// POST /orgs/:id/members — add/update a member by wallet address (admin+).
	fastify.post(
		"/orgs/:id/members",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const body = addMemberSchema.safeParse(request.body);
			if (!body.success || !evmAddress.test(body.data.address)) {
				return reply.code(400).send({ error: "invalid_member" });
			}

			// The member must already be a known user (they sign in via SIWE first).
			const user = await db.query.users.findFirst({
				where: (u, { eq: eqOp }) => eqOp(u.address, body.data.address),
			});
			if (!user) {
				return reply.code(404).send({ error: "user_not_found" });
			}

			await db
				.insert(orgMembers)
				.values({ orgId, userId: user.id, role: body.data.role })
				.onConflictDoUpdate({
					target: [orgMembers.orgId, orgMembers.userId],
					set: { role: body.data.role },
				});

			return reply.code(201).send({ userId: user.id, role: body.data.role });
		},
	);

	// POST /orgs/:id/treasury — provision the managed treasury (owner/admin).
	// Generates an EOA, seals its key under APP_MASTER_KEY, and records custody
	// consent. On-chain onboarding + server-side eERC registration are performed
	// by the payroll runner tranche; the sealed eERC key is populated then.
	fastify.post(
		"/orgs/:id/treasury",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const body = provisionTreasurySchema.safeParse(request.body);
			if (!body.success) {
				return reply
					.code(400)
					.send({ error: "consent_required" });
			}

			const existing = await db
				.select({ address: orgTreasuries.address })
				.from(orgTreasuries)
				.where(eq(orgTreasuries.orgId, orgId))
				.limit(1);
			if (existing.length > 0) {
				return reply.code(409).send({ error: "treasury_exists" });
			}

			const privateKey = generatePrivateKey();
			const account = privateKeyToAccount(privateKey);
			const sealedEoaKey = sealString(options.config.appMasterKey, privateKey);

			await db.insert(orgTreasuries).values({
				orgId,
				address: account.address.toLowerCase(),
				sealedEoaKey,
				consentedAt: new Date(),
				consentedBy: request.user!.id,
			});

			return reply.code(201).send({
				address: account.address,
				custody: "managed",
				consented: true,
				registered: false,
			});
		},
	);

	// GET /orgs/:id/treasury — custody status; never returns key material.
	fastify.get(
		"/orgs/:id/treasury",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const [treasury] = await db
				.select({
					address: orgTreasuries.address,
					consentedAt: orgTreasuries.consentedAt,
					sealedEercKey: orgTreasuries.sealedEercKey,
				})
				.from(orgTreasuries)
				.where(eq(orgTreasuries.orgId, orgId))
				.limit(1);

			if (!treasury) {
				return reply.code(404).send({ error: "treasury_not_found" });
			}

			return reply.send({
				address: getAddress(treasury.address),
				custody: "managed",
				consented: treasury.consentedAt !== null,
				registered: treasury.sealedEercKey !== null,
			});
		},
	);
};
