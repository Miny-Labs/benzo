import { createServer, type Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import { auditLog } from "../src/db/schema.js";
import {
	createBoss,
	enqueueDemoAuditJob,
	ensureQueues,
	registerJobs,
} from "../src/jobs/index.js";

const testMasterKey =
	"0000000000000000000000000000000000000000000000000000000000000000";
const testOpsPrivateKey =
	"0x0000000000000000000000000000000000000000000000000000000000000001";

describe("@benzo/api", () => {
	let postgres: StartedPostgreSqlContainer;
	let rpc: Awaited<ReturnType<typeof startRpcServer>>;
	let config: ApiConfig;

	beforeAll(async () => {
		postgres = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_api_test")
			.withUsername("benzo")
			.withPassword("benzo")
			.start();
		rpc = await startRpcServer();
		config = {
			appMasterKey: testMasterKey,
			benzonetChainId: 43_113,
			benzonetRpcUrl: rpc.url,
			databaseUrl: postgres.getConnectionUri(),
			host: "127.0.0.1",
			logLevel: "silent",
			nodeEnv: "test",
			opsPrivateKey: testOpsPrivateKey,
			port: 0,
			sessionCookieName: "benzo_test_session",
			sessionTtlDays: 7,
			siweNonceTtlMinutes: 10,
		};

		await migrateTestDatabase(config);
	});

	afterAll(async () => {
		await rpc.close();
		await postgres.stop();
	});

	it("serves /healthz with DB and RPC status plus request id", async () => {
		const app = await buildApp({ config, logger: false });

		try {
			const response = await app.inject({
				headers: {
					"x-request-id": "health-test-request",
				},
				method: "GET",
				url: "/healthz",
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers["x-request-id"]).toBe("health-test-request");
			expect(response.json()).toMatchObject({
				db: { ok: true },
				rpc: { blockNumber: "42", ok: true },
				status: "ok",
			});
		} finally {
			await app.close();
		}
	});

	it("completes nonce, SIWE verify, /auth/me, and logout", async () => {
		const app = await buildApp({ config, logger: false });
		const account = privateKeyToAccount(generatePrivateKey());

		try {
			const nonceResponse = await app.inject({
				method: "GET",
				url: `/auth/nonce?address=${account.address}`,
			});
			expect(nonceResponse.statusCode).toBe(200);
			const { nonce } = nonceResponse.json<{ nonce: string }>();
			const message = createSiweMessage({
				address: account.address,
				chainId: config.benzonetChainId,
				domain: "localhost",
				issuedAt: new Date(),
				nonce,
				uri: "http://localhost",
				version: "1",
			});
			const signature = await account.signMessage({ message });

			const verifyResponse = await app.inject({
				headers: {
					host: "localhost",
				},
				method: "POST",
				payload: {
					message,
					signature,
				},
				url: "/auth/verify",
			});

			expect(verifyResponse.statusCode).toBe(200);
			expect(verifyResponse.json()).toMatchObject({
				user: {
					address: account.address.toLowerCase(),
					roles: [],
				},
			});
			const cookie = extractCookie(verifyResponse.headers["set-cookie"]);
			expect(cookie).toContain(config.sessionCookieName);

			const meResponse = await app.inject({
				headers: {
					cookie,
				},
				method: "GET",
				url: "/auth/me",
			});
			expect(meResponse.statusCode).toBe(200);
			expect(meResponse.json()).toMatchObject({
				user: {
					address: account.address.toLowerCase(),
					roles: [],
				},
			});

			const logoutResponse = await app.inject({
				headers: {
					cookie,
				},
				method: "POST",
				url: "/auth/logout",
			});
			expect(logoutResponse.statusCode).toBe(200);

			const loggedOutMeResponse = await app.inject({
				headers: {
					cookie,
				},
				method: "GET",
				url: "/auth/me",
			});
			expect(loggedOutMeResponse.statusCode).toBe(401);
		} finally {
			await app.close();
		}
	});

	it("enqueues the demo pg-boss job transactionally and processes it after restart", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const firstBoss = createBoss(config);
		let secondBoss: PgBoss | undefined;

		try {
			await firstBoss.start();
			await ensureQueues(firstBoss);

			const jobId = await enqueueDemoAuditJob(db, firstBoss, {
				actor: "test:operator",
				subject: "demo:restart",
			});

			expect(jobId).toEqual(expect.any(String));
			expect(await countAuditRows(db, "demo_job_enqueued")).toBe(1);

			await firstBoss.stop();
			secondBoss = createBoss(config);
			await secondBoss.start();
			await registerJobs(secondBoss, db, pino({ enabled: false }));

			await waitFor(async () => {
				expect(await countAuditRows(db, "demo_job_processed")).toBe(1);
			});
		} finally {
			await firstBoss.stop().catch(() => undefined);
			await secondBoss?.stop().catch(() => undefined);
			await pool.end();
		}
	});
});

async function migrateTestDatabase(config: ApiConfig): Promise<void> {
	const pool = createPool(config);
	const db = createDb(pool);
	const migrationsFolder = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../drizzle",
	);

	try {
		await migrate(db, { migrationsFolder });
	} finally {
		await pool.end();
	}
}

function extractCookie(header: string | string[] | number | undefined): string {
	if (Array.isArray(header)) {
		return header[0]?.split(";")[0] ?? "";
	}

	if (typeof header === "string") {
		return header.split(";")[0] ?? "";
	}

	return "";
}

async function countAuditRows(
	db: Database,
	action: string,
): Promise<number> {
	const [row] = await db
		.select({
			count: sql<number>`count(*)::int`,
		})
		.from(auditLog)
		.where(and(eq(auditLog.action, action), eq(auditLog.subject, "demo:restart")));

	return row?.count ?? 0;
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
	const startedAt = Date.now();
	let lastError: unknown;

	while (Date.now() - startedAt < 15_000) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	throw lastError;
}

async function startRpcServer(): Promise<{
	close: () => Promise<void>;
	url: string;
}> {
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];

		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			id?: number | string;
			method?: string;
		};
		const result = payload.method === "eth_chainId" ? "0xa869" : "0x2a";

		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				id: payload.id ?? 1,
				jsonrpc: "2.0",
				result,
			}),
		);
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	return {
		close: () => closeServer(server),
		url: `http://127.0.0.1:${addressPort(server)}`,
	};
}

function addressPort(server: Server): number {
	const address = server.address();

	if (!address || typeof address === "string") {
		throw new Error("RPC server did not bind a TCP port");
	}

	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}
