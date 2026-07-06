import { and, eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { orgMembers, type OrgRole } from "../db/schema.js";

declare module "fastify" {
	interface FastifyRequest {
		orgRole?: OrgRole;
	}
}

// Role hierarchy: a higher rank implies every capability of the ranks below it.
export const ROLE_RANK: Record<OrgRole, number> = {
	viewer: 0,
	operator: 1,
	admin: 2,
	owner: 3,
};

// The caller's membership role in `orgId`, or null if they're not a member.
export const loadMembership = async (
	db: Database,
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

// Build a preHandler that gates an org-scoped route (`:id` param) on a minimum
// role. Returns 404 (not 403) to non-members so org existence isn't leaked.
export const makeRequireOrgRole =
	(fastify: FastifyInstance, db: Database) =>
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

		const role = await loadMembership(db, orgId, request.user!.id);
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
