import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import {
	auditLog,
	drips,
	onboardings,
	sessions,
	users,
	type UserRole,
} from "../src/db/schema.js";
import {
	createBoss,
	enqueueDemoAuditJob,
	ensureQueues,
	registerJobs,
} from "../src/jobs/index.js";
import type {
	AllowlistStepResult,
	GasDripStepResult,
	OnboardingChainClient,
} from "../src/onboarding/chain.js";
import {
	handleOnboardingJob,
	type OnboardingJobData,
	type OnboardingStatusResponse,
} from "../src/onboarding/service.js";

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
			apiDomain: "localhost",
			benzonetChainId: 43_113,
			benzonetRpcUrl: rpc.url,
			chainEnv: "fuji",
			databaseUrl: postgres.getConnectionUri(),
			dripBalanceThresholdWei: 500_000_000_000_000_000n,
			dripWei: 500_000_000_000_000_000n,
			eercDeploymentManifest: undefined,
			eercRegistrarAddress: undefined,
			host: "127.0.0.1",
			kycProvider: "mock",
			logLevel: "silent",
			nodeEnv: "test",
			onboardingRegistrationPollSeconds: 1,
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

	it("rejects SIWE messages for a non-configured domain even when Host matches", async () => {
		const app = await buildApp({ config, logger: false });
		const account = privateKeyToAccount(generatePrivateKey());
		const attackerDomain = "attacker.example";

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
				domain: attackerDomain,
				issuedAt: new Date(),
				nonce,
				uri: `https://${attackerDomain}`,
				version: "1",
			});
			const signature = await account.signMessage({ message });

			const verifyResponse = await app.inject({
				headers: {
					host: attackerDomain,
				},
				method: "POST",
				payload: {
					message,
					signature,
				},
				url: "/auth/verify",
			});

			expect(verifyResponse.statusCode).toBe(401);
			expect(verifyResponse.json()).toEqual({ error: "wrong_domain" });
		} finally {
			await app.close();
		}
	});

	it("consumes a SIWE nonce when signature verification fails", async () => {
		const app = await buildApp({ config, logger: false });
		const account = privateKeyToAccount(generatePrivateKey());
		const attackerAccount = privateKeyToAccount(generatePrivateKey());

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
			const invalidSignature = await attackerAccount.signMessage({ message });

			const failedVerifyResponse = await app.inject({
				headers: {
					host: "localhost",
				},
				method: "POST",
				payload: {
					message,
					signature: invalidSignature,
				},
				url: "/auth/verify",
			});

			expect(failedVerifyResponse.statusCode).toBe(401);
			expect(failedVerifyResponse.json()).toEqual({ error: "invalid_signature" });

			const validSignature = await account.signMessage({ message });
			const retryResponse = await app.inject({
				headers: {
					host: "localhost",
				},
				method: "POST",
				payload: {
					message,
					signature: validSignature,
				},
				url: "/auth/verify",
			});

			expect(retryResponse.statusCode).toBe(401);
			expect(retryResponse.json()).toEqual({ error: "invalid_nonce" });
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

			const duplicateJobId = await enqueueDemoAuditJob(db, firstBoss, {
				actor: "test:operator",
				subject: "demo:restart",
			});

			expect(duplicateJobId).toBeNull();
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

	it("runs Fuji onboarding with allowlist no-op, plain gas transfer, and registration polling", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const boss = createBoss(config);
		const chain = createOnboardingChainStub({
			chainEnv: "fuji",
			registered: false,
		});
		const app = await buildApp({
			boss,
			config,
			db,
			logger: false,
			onboardingChain: chain,
			pool,
		});
		const account = privateKeyToAccount(generatePrivateKey());

		try {
			const { cookie } = await createAuthenticatedSession(
				db,
				config,
				account.address,
			);

			const startResponses = await Promise.all(
				Array.from({ length: 2 }, () =>
					app.inject({
						headers: { cookie },
						method: "POST",
						payload: {
							mockKyc: {
								country: "US",
								name: "Ava Example",
							},
						},
						url: "/onboarding/start",
					}),
				),
			);

			expect(startResponses.map((response) => response.statusCode)).toEqual([
				202, 202,
			]);

			await waitFor(async () => {
				const onboarding = await fetchOnboardingStatus(app, cookie);
				expect(onboarding.status).toBe("awaiting_registration");
			});

			let onboarding = await fetchOnboardingStatus(app, cookie);
			expect(onboarding).toMatchObject({
				chainEnv: "fuji",
				mockKyc: {
					payload: {
						country: "US",
						label: "MOCK_KYC_NO_DOCUMENTS",
						name: "Ava Example",
					},
					provider: "mock",
				},
				steps: {
					allowlist: {
						result: "noop_fuji_no_tx_allowlist",
						txHash: null,
					},
					gas: {
						result: "fuji_plain_transfer_sent",
						txHash: txHash(1),
					},
				},
			});
			expect(chain.calls.allowlistWrites).toBe(0);
			expect(chain.calls.drips).toBe(1);

			chain.setRegistered(true);

			await waitFor(async () => {
				onboarding = await fetchOnboardingStatus(app, cookie);
				expect(onboarding.status).toBe("complete");
			});

			const streamResponse = await app.inject({
				headers: { cookie },
				method: "GET",
				url: "/onboarding/status/stream",
			});

			expect(streamResponse.statusCode).toBe(200);
			expect(streamResponse.body).toContain("event: status");
			expect(streamResponse.body).toContain('"status":"complete"');
		} finally {
			await app.close();
			await boss.stop().catch(() => undefined);
			await pool.end();
		}
	});

	it("runs BenzoNet onboarding idempotently across concurrent starts", async () => {
		const benzonetConfig: ApiConfig = {
			...config,
			benzonetChainId: 68_420,
			chainEnv: "benzonet",
		};
		const pool = createPool(benzonetConfig);
		const db = createDb(pool);
		const boss = createBoss(benzonetConfig);
		const chain = createOnboardingChainStub({
			chainEnv: "benzonet",
			chainId: benzonetConfig.benzonetChainId,
			registered: true,
		});
		const app = await buildApp({
			boss,
			config: benzonetConfig,
			db,
			logger: false,
			onboardingChain: chain,
			pool,
		});
		const userAccount = privateKeyToAccount(generatePrivateKey());
		const adminAccount = privateKeyToAccount(generatePrivateKey());

		try {
			const { cookie, userId } = await createAuthenticatedSession(
				db,
				benzonetConfig,
				userAccount.address,
			);
			const admin = await createAuthenticatedSession(
				db,
				benzonetConfig,
				adminAccount.address,
				["network_admin"],
			);

			const startResponses = await Promise.all(
				Array.from({ length: 5 }, () =>
					app.inject({
						headers: { cookie },
						method: "POST",
						payload: {
							mockKyc: {
								country: "CA",
								name: "Concurrent User",
							},
						},
						url: "/onboarding/start",
					}),
				),
			);

			expect(startResponses.every((response) => response.statusCode === 202)).toBe(
				true,
			);

			await waitFor(async () => {
				const onboarding = await fetchOnboardingStatus(app, cookie);
				expect(onboarding.status).toBe("complete");
			});

			const onboarding = await fetchOnboardingStatus(app, cookie);
			expect(onboarding.steps.allowlist).toMatchObject({
				result: "enabled",
				txHash: txHash(1),
			});
			expect(onboarding.steps.gas).toMatchObject({
				result: "benzonet_native_minter_sent",
				txHash: txHash(2),
			});
			expect(chain.calls.allowlistReads).toBe(1);
			expect(chain.calls.allowlistWrites).toBe(1);
			expect(chain.calls.drips).toBe(1);
			expect(await countOnboardingsForUser(db, userId)).toBe(1);
			expect(await countDripsForAddress(db, userAccount.address.toLowerCase())).toBe(
				1,
			);

			const adminResponse = await app.inject({
				headers: { cookie: admin.cookie },
				method: "GET",
				url: "/admin/onboardings?status=complete",
			});

			expect(adminResponse.statusCode).toBe(200);
			expect(adminResponse.json()).toMatchObject({
				onboardings: expect.arrayContaining([
					expect.objectContaining({
						address: userAccount.address.toLowerCase(),
						status: "complete",
					}),
				]),
			});

			const paginatedAdminResponse = await app.inject({
				headers: { cookie: admin.cookie },
				method: "GET",
				url: "/admin/onboardings?status=complete&limit=1&offset=0",
			});
			const paginatedAdminBody = paginatedAdminResponse.json<{
				limit: number;
				offset: number;
				onboardings: OnboardingStatusResponse[];
			}>();

			expect(paginatedAdminResponse.statusCode).toBe(200);
			expect(paginatedAdminBody.limit).toBe(1);
			expect(paginatedAdminBody.offset).toBe(0);
			expect(paginatedAdminBody.onboardings.length).toBeLessThanOrEqual(1);
		} finally {
			await app.close();
			await boss.stop().catch(() => undefined);
			await pool.end();
		}
	});

	it("resumes awaiting registration after service restart without repeating chain steps", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const firstBoss = createBoss(config);
		const chain = createOnboardingChainStub({
			chainEnv: "fuji",
			registered: false,
		});
		const account = privateKeyToAccount(generatePrivateKey());
		const firstApp = await buildApp({
			boss: firstBoss,
			config,
			db,
			logger: false,
			onboardingChain: chain,
			pool,
		});
		let firstAppClosed = false;
		let secondBoss: PgBoss | undefined;
		let secondApp: Awaited<ReturnType<typeof buildApp>> | undefined;

		try {
			const { cookie } = await createAuthenticatedSession(
				db,
				config,
				account.address,
			);

			const startResponse = await firstApp.inject({
				headers: { cookie },
				method: "POST",
				url: "/onboarding/start",
			});

			expect(startResponse.statusCode).toBe(202);

			await waitFor(async () => {
				const onboarding = await fetchOnboardingStatus(firstApp, cookie);
				expect(onboarding.status).toBe("awaiting_registration");
			});
			expect(chain.calls.drips).toBe(1);

			await firstApp.close();
			firstAppClosed = true;
			await firstBoss.stop().catch(() => undefined);
			chain.setRegistered(true);

			secondBoss = createBoss(config);
			secondApp = await buildApp({
				boss: secondBoss,
				config,
				db,
				logger: false,
				onboardingChain: chain,
				pool,
			});

			await waitFor(async () => {
				const onboarding = await fetchOnboardingStatus(secondApp!, cookie);
				expect(onboarding.status).toBe("complete");
			});
			expect(chain.calls.allowlistWrites).toBe(0);
			expect(chain.calls.drips).toBe(1);
		} finally {
			await secondApp?.close();
			await secondBoss?.stop().catch(() => undefined);
			if (!firstAppClosed) {
				await firstApp.close();
			}
			await firstBoss.stop().catch(() => undefined);
			await pool.end();
		}
	});

	it("resumes pending KYC after service restart with original mock KYC data", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const firstBoss = createBoss(config);
		const chain = createOnboardingChainStub({
			chainEnv: "fuji",
			registered: true,
		});
		const account = privateKeyToAccount(generatePrivateKey());
		let firstApp: Awaited<ReturnType<typeof buildApp>> | undefined;
		let firstBossStarted = false;
		let secondBoss: PgBoss | undefined;
		let secondApp: Awaited<ReturnType<typeof buildApp>> | undefined;

		try {
			await firstBoss.start();
			firstBossStarted = true;
			await ensureQueues(firstBoss);

			firstApp = await buildApp({
				boss: firstBoss,
				config,
				db,
				logger: false,
				onboardingChain: chain,
				pool,
				startBoss: false,
			});

			const { cookie } = await createAuthenticatedSession(
				db,
				config,
				account.address,
			);

			const startResponse = await firstApp.inject({
				headers: { cookie },
				method: "POST",
				payload: {
					mockKyc: {
						country: "gb",
						name: "Pending Resume User",
					},
				},
				url: "/onboarding/start",
			});

			expect(startResponse.statusCode).toBe(202);

			const pendingOnboarding = await fetchOnboardingStatus(firstApp, cookie);
			expect(pendingOnboarding.status).toBe("pending_kyc");
			expect(pendingOnboarding.mockKyc).toMatchObject({
				approvedAt: null,
				payload: null,
				provider: null,
			});

			await firstApp.close();
			firstApp = undefined;
			await firstBoss.stop();
			firstBossStarted = false;

			secondBoss = createBoss(config);
			secondApp = await buildApp({
				boss: secondBoss,
				config,
				db,
				logger: false,
				onboardingChain: chain,
				pool,
			});

			await waitFor(async () => {
				const onboarding = await fetchOnboardingStatus(secondApp!, cookie);
				expect(onboarding.status).toBe("complete");
				expect(onboarding.mockKyc?.payload).toEqual({
					country: "GB",
					label: "MOCK_KYC_NO_DOCUMENTS",
					name: "Pending Resume User",
				});
			});
		} finally {
			await secondApp?.close();
			await secondBoss?.stop().catch(() => undefined);
			await firstApp?.close();
			if (firstBossStarted) {
				await firstBoss.stop().catch(() => undefined);
			}
			await pool.end();
		}
	});

	it("marks an unhandled onboarding status failed instead of re-enqueueing forever", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const chain = createOnboardingChainStub({
			chainEnv: "fuji",
			registered: true,
		});
		const account = privateKeyToAccount(generatePrivateKey());

		try {
			const { userId } = await createAuthenticatedSession(
				db,
				config,
				account.address,
			);

			await db.insert(onboardings).values({
				chainEnv: config.chainEnv,
				chainId: config.benzonetChainId,
				status: "pending_kyc",
				userId,
			});
			await db.execute(
				sql`ALTER TYPE onboarding_status ADD VALUE IF NOT EXISTS 'mystery_status'`,
			);
			await db.execute(
				sql`UPDATE onboardings SET status = 'mystery_status'::onboarding_status WHERE user_id = ${userId}`,
			);

			await handleOnboardingJob(
				db,
				{} as PgBoss,
				{
					chain,
					config,
					kycProvider: {
						async approve() {
							throw new Error("kyc_not_expected");
						},
						name: "mock",
					},
				},
				{
					data: {
						address: account.address.toLowerCase(),
						userId,
					},
					retryCount: 0,
					retryLimit: 8,
				} as JobWithMetadata<OnboardingJobData>,
			);

			const [row] = await db
				.select({
					error: onboardings.error,
					status: onboardings.status,
				})
				.from(onboardings)
				.where(eq(onboardings.userId, userId))
				.limit(1);

			expect(row).toEqual({
				error: "unhandled_onboarding_status:mystery_status",
				status: "failed",
			});
			expect(chain.calls.registrationPolls).toBe(0);
		} finally {
			await pool.end();
		}
	});

	it("returns 404 before opening the status stream when onboarding is missing", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({
			config,
			db,
			logger: false,
			pool,
			startBoss: false,
		});
		const account = privateKeyToAccount(generatePrivateKey());

		try {
			const { cookie } = await createAuthenticatedSession(
				db,
				config,
				account.address,
			);
			const response = await app.inject({
				headers: { cookie },
				method: "GET",
				url: "/onboarding/status/stream",
			});

			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({ error: "onboarding_not_started" });
		} finally {
			await app.close();
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

async function createAuthenticatedSession(
	db: Database,
	config: ApiConfig,
	address: string,
	roles: UserRole[] = [],
): Promise<{
	cookie: string;
	userId: string;
}> {
	const normalizedAddress = address.toLowerCase();
	const [user] = await db
		.insert(users)
		.values({
			address: normalizedAddress,
			roles,
		})
		.onConflictDoUpdate({
			set: {
				roles,
			},
			target: users.address,
		})
		.returning({
			id: users.id,
		});

	if (!user) {
		throw new Error("test_user_create_failed");
	}

	const sessionId = randomBytes(32).toString("hex");
	await db.insert(sessions).values({
		expiresAt: new Date(Date.now() + 86_400_000),
		id: sessionId,
		userId: user.id,
	});

	return {
		cookie: `${config.sessionCookieName}=${sessionId}`,
		userId: user.id,
	};
}

async function fetchOnboardingStatus(
	app: Awaited<ReturnType<typeof buildApp>>,
	cookie: string,
): Promise<OnboardingStatusResponse> {
	const response = await app.inject({
		headers: { cookie },
		method: "GET",
		url: "/onboarding/status",
	});

	expect(response.statusCode).toBe(200);

	return response.json<{ onboarding: OnboardingStatusResponse }>().onboarding;
}

async function countOnboardingsForUser(
	db: Database,
	userId: string,
): Promise<number> {
	const [row] = await db
		.select({
			count: sql<number>`count(*)::int`,
		})
		.from(onboardings)
		.where(eq(onboardings.userId, userId));

	return row?.count ?? 0;
}

async function countDripsForAddress(
	db: Database,
	address: string,
): Promise<number> {
	const [row] = await db
		.select({
			count: sql<number>`count(*)::int`,
		})
		.from(drips)
		.where(eq(drips.address, address));

	return row?.count ?? 0;
}

type OnboardingChainStub = OnboardingChainClient & {
	calls: {
		allowlistReads: number;
		allowlistWrites: number;
		balanceReads: number;
		drips: number;
		registrationPolls: number;
	};
	setNativeBalance: (balance: bigint) => void;
	setRegistered: (registered: boolean) => void;
};

function createOnboardingChainStub(input: {
	allowlistLevel?: bigint;
	chainEnv: "fuji" | "benzonet";
	chainId?: number;
	nativeBalance?: bigint;
	registered: boolean;
}): OnboardingChainStub {
	let allowlistLevel = input.allowlistLevel ?? 0n;
	let nativeBalance = input.nativeBalance ?? 0n;
	let registered = input.registered;
	let nextTxId = 1;
	const calls = {
		allowlistReads: 0,
		allowlistWrites: 0,
		balanceReads: 0,
		drips: 0,
		registrationPolls: 0,
	};

	return {
		calls,
		chainEnv: input.chainEnv,
		chainId: input.chainId ?? (input.chainEnv === "fuji" ? 43_113 : 68_420),
		async dripGas(_address, amountWei): Promise<GasDripStepResult> {
			calls.drips += 1;
			nativeBalance += amountWei;

			return {
				mode:
					input.chainEnv === "fuji"
						? "fuji_plain_transfer"
						: "benzonet_native_minter",
				result: "sent",
				txHash: txHash(nextTxId++),
			};
		},
		async ensureAllowlisted(): Promise<AllowlistStepResult> {
			if (input.chainEnv === "fuji") {
				return {
					result: "noop_fuji_no_tx_allowlist",
					txHash: null,
				};
			}

			calls.allowlistReads += 1;

			if (allowlistLevel >= 1n) {
				return {
					result: "already_enabled",
					txHash: null,
				};
			}

			calls.allowlistWrites += 1;
			allowlistLevel = 1n;

			return {
				result: "enabled",
				txHash: txHash(nextTxId++),
			};
		},
		async getNativeBalance() {
			calls.balanceReads += 1;
			return nativeBalance;
		},
		async isUserRegistered() {
			calls.registrationPolls += 1;
			return registered;
		},
		setNativeBalance(balance) {
			nativeBalance = balance;
		},
		setRegistered(value) {
			registered = value;
		},
	};
}

function txHash(id: number): `0x${string}` {
	return `0x${id.toString(16).padStart(64, "0")}`;
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
