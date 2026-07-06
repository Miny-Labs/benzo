import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Address, Hex, PublicClient } from "viem";
import { getAddress, isAddress } from "viem";
import {
	generateSiweNonce,
	parseSiweMessage,
	verifySiweMessage,
} from "viem/siwe";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { auditLog, sessions, siweNonces, users } from "../db/schema.js";

const nonceQuerySchema = z.object({
	address: z.string().refine((value) => isAddress(value, { strict: false }), {
		message: "address must be an EVM address",
	}),
});

const verifyBodySchema = z.object({
	message: z.string().min(1),
	signature: z.custom<Hex>(
		(value) => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value),
		"signature must be a 0x-prefixed hex string",
	),
});

type AuthRoutesOptions = {
	config: ApiConfig;
	db: Database;
	publicClient: PublicClient;
};

class AuthVerificationError extends Error {}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.get("/auth/nonce", async (request, reply) => {
		const query = nonceQuerySchema.safeParse(request.query);

		if (!query.success) {
			return reply.code(400).send({ error: "invalid_address" });
		}

		const address = normalizeAddress(query.data.address);
		const nonce = generateSiweNonce();
		const expiresAt = minutesFromNow(options.config.siweNonceTtlMinutes);

		await options.db.insert(siweNonces).values({
			address,
			expiresAt,
			nonce,
		});

		return reply.send({
			expiresAt: expiresAt.toISOString(),
			nonce,
		});
	});

	fastify.post("/auth/verify", async (request, reply) => {
		const body = verifyBodySchema.safeParse(request.body);

		if (!body.success) {
			return reply.code(400).send({ error: "invalid_siwe_payload" });
		}

		const domain = request.headers.host;

		if (!domain) {
			return reply.code(400).send({ error: "missing_host_header" });
		}

		const parsed = (() => {
			try {
				return parseSiweMessage(body.data.message);
			} catch {
				return null;
			}
		})();

		if (!parsed?.address || !parsed.chainId || !parsed.nonce) {
			return reply.code(400).send({ error: "invalid_siwe_message" });
		}

		if (parsed.chainId !== options.config.benzonetChainId) {
			return reply.code(401).send({ error: "wrong_chain" });
		}

		const address = normalizeAddress(parsed.address);
		const nonce = parsed.nonce;
		const nonceExists = await hasLiveNonce(options.db, nonce, address);

		if (!nonceExists) {
			return reply.code(401).send({ error: "invalid_nonce" });
		}

		const verified = await verifySiweMessage(options.publicClient, {
			address: parsed.address as Address,
			domain,
			message: body.data.message,
			nonce,
			signature: body.data.signature,
		});

		if (!verified) {
			return reply.code(401).send({ error: "invalid_signature" });
		}

		try {
			const { expiresAt, sessionId, user } = await createSession(
				options.db,
				options.config,
				{
					address,
					nonce,
				},
			);

			reply.setCookie(options.config.sessionCookieName, sessionId, {
				expires: expiresAt,
				httpOnly: true,
				path: "/",
				sameSite: "lax",
				secure: options.config.nodeEnv === "production",
			});

			return reply.send({
				user,
			});
		} catch (error) {
			if (error instanceof AuthVerificationError) {
				return reply.code(401).send({ error: "invalid_nonce" });
			}

			throw error;
		}
	});

	fastify.post("/auth/logout", async (request, reply) => {
		const sessionId = request.cookies[options.config.sessionCookieName];

		if (sessionId) {
			await options.db.delete(sessions).where(eq(sessions.id, sessionId));
		}

		reply.clearCookie(options.config.sessionCookieName, {
			path: "/",
			sameSite: "lax",
			secure: options.config.nodeEnv === "production",
		});

		return reply.send({ ok: true });
	});

	fastify.get("/auth/me", { preHandler: fastify.requireAuth }, async (request) => ({
		user: request.user,
	}));
};

function minutesFromNow(minutes: number): Date {
	return new Date(Date.now() + minutes * 60_000);
}

function daysFromNow(days: number): Date {
	return new Date(Date.now() + days * 86_400_000);
}

function normalizeAddress(address: string): string {
	return getAddress(address).toLowerCase();
}

async function hasLiveNonce(
	db: Database,
	nonce: string,
	address: string,
): Promise<boolean> {
	const [row] = await db
		.select({ nonce: siweNonces.nonce })
		.from(siweNonces)
		.where(
			and(
				eq(siweNonces.nonce, nonce),
				eq(siweNonces.address, address),
				gt(siweNonces.expiresAt, new Date()),
			),
		)
		.limit(1);

	return Boolean(row);
}

async function createSession(
	db: Database,
	config: ApiConfig,
	input: {
		address: string;
		nonce: string;
	},
): Promise<{
	expiresAt: Date;
	sessionId: string;
	user: {
		address: string;
		id: string;
		roles: string[];
	};
}> {
	const expiresAt = daysFromNow(config.sessionTtlDays);
	const sessionId = randomBytes(32).toString("hex");

	return db.transaction(async (tx) => {
		const [nonce] = await tx
			.delete(siweNonces)
			.where(
				and(
					eq(siweNonces.nonce, input.nonce),
					eq(siweNonces.address, input.address),
					gt(siweNonces.expiresAt, new Date()),
				),
			)
			.returning({ nonce: siweNonces.nonce });

		if (!nonce) {
			throw new AuthVerificationError("nonce already consumed");
		}

		const [user] = await tx
			.insert(users)
			.values({
				address: input.address,
			})
			.onConflictDoUpdate({
				set: {
					address: input.address,
				},
				target: users.address,
			})
			.returning({
				address: users.address,
				id: users.id,
				roles: users.roles,
			});

		if (!user) {
			throw new AuthVerificationError("user upsert failed");
		}

		await tx.insert(sessions).values({
			expiresAt,
			id: sessionId,
			userId: user.id,
		});

		await tx.insert(auditLog).values({
			action: "auth.verify",
			actor: user.address,
			meta: {
				sessionExpiresAt: expiresAt.toISOString(),
			},
			subject: user.id,
		});

		return {
			expiresAt,
			sessionId,
			user,
		};
	});
}
