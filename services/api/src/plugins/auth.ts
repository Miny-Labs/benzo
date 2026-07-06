import fp from "fastify-plugin";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { sessions, users, type UserRole } from "../db/schema.js";

export type AuthenticatedUser = {
	address: string;
	id: string;
	roles: UserRole[];
};

declare module "fastify" {
	interface FastifyInstance {
		requireAuth: preHandlerAsyncHookHandler;
		requireRole: (role: UserRole) => preHandlerAsyncHookHandler;
	}

	interface FastifyRequest {
		user?: AuthenticatedUser;
	}
}

type AuthPluginOptions = {
	config: ApiConfig;
	db: Database;
};

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
	fastify,
	options,
) => {
	const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
		const sessionId = request.cookies[options.config.sessionCookieName];

		if (!sessionId) {
			await reply.code(401).send({ error: "unauthorized" });
			return;
		}

		const [sessionUser] = await options.db
			.select({
				address: users.address,
				id: users.id,
				roles: users.roles,
			})
			.from(sessions)
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(
				and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())),
			)
			.limit(1);

		if (!sessionUser) {
			await reply.code(401).send({ error: "unauthorized" });
			return;
		}

		request.user = sessionUser;
	};

	fastify.decorate("requireAuth", requireAuth);
	fastify.decorate("requireRole", (role: UserRole) => {
		const requireRole: preHandlerAsyncHookHandler = async (request, reply) => {
			await requireAuth.call(fastify, request, reply);

			if (reply.sent) {
				return;
			}

			if (!request.user?.roles.includes(role)) {
				await reply.code(403).send({ error: "forbidden" });
			}
		};

		return requireRole;
	});
};

export default fp(authPlugin, {
	name: "benzo-auth",
});
