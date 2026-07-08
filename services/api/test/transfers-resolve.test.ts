import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { buildApp } from "../src/app.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import { handles, invites, sessions, users } from "../src/db/schema.js";
import type {
	ClaimedHandle,
	HandleResolution,
	IdentityChainClient,
} from "../src/identity/chain.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTERED = getAddress("0x1111111111111111111111111111111111111111");
const UNREGISTERED = getAddress("0x2222222222222222222222222222222222222222");
const CREATOR = getAddress("0x3333333333333333333333333333333333333333");
const CLAIMANT = getAddress("0x4444444444444444444444444444444444444444");

function testConfig(databaseUrl: string): ApiConfig {
	return {
		appMasterKey:
			"0000000000000000000000000000000000000000000000000000000000000000",
		apiDomain: "localhost",
		autoDepositRouterAddress: null,
		benzonetChainId: 43_113,
		benzonetRpcUrl: "http://127.0.0.1:1",
		cctpAttestationApiBase: "https://iris-api-sandbox.circle.com",
		cctpDestDomain: 1,
		cctpDomain: null,
		cctpMessageTransmitter: null,
		cctpTokenMessenger: null,
		chainEnv: "fuji",
		corsOrigins: [...DEFAULT_CORS_ORIGINS],
		databaseUrl,
		dripBalanceThresholdWei: 500_000_000_000_000_000n,
		dripWei: 500_000_000_000_000_000n,
		eercDeploymentManifest: undefined,
		eercEncryptedErcAddress: "0x9e16ed3b799541b4929f7e2014904c65e81035b1",
		eercRegistrarAddress: "0x9a63fea9851097dbaf3757b636217fdde50abaf0",
		handleRegistryAddress: undefined,
		host: "127.0.0.1",
		indexerConfirmations: 6,
		indexerEnabled: false,
		indexerMaxWindowBlocks: 2_000,
		indexerPollCron: "*/5 * * * * *",
		indexerStartBlock: 0n,
		kycProvider: "mock",
		logLevel: "silent",
		nodeEnv: "test",
		onboardingRegistrationPollSeconds: 1,
		onrampPollCron: "*/15 * * * * *",
		onrampPollerEnabled: true,
		opsPrivateKey:
			"0x0000000000000000000000000000000000000000000000000000000000000001",
		payrollEercDecimals: 6,
		payrollTokenId: 1n,
		payrollZkArtifactDir: "/tmp/benzo-test-zk-artifacts",
		port: 0,
		relayerPrivateKey:
			"0x0000000000000000000000000000000000000000000000000000000000000002",
		sessionCookieName: "benzo_test_session",
		sessionTtlDays: 7,
		siweNonceTtlMinutes: 10,
		tier: "staging",
	};
}

describe("transfer recipient resolution", () => {
	let app: Awaited<ReturnType<typeof buildApp>>;
	let config: ApiConfig;
	let container: StartedPostgreSqlContainer;
	let db: Database;
	let identityChain: RecordingIdentityChainClient;
	let pool: Pool;

	beforeAll(async () => {
		container = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_transfers_test")
			.withUsername("benzo")
			.start();
		config = testConfig(container.getConnectionUri());
		pool = createPool(config);
		db = createDb(pool);
		await migrate(db, { migrationsFolder: path.join(dirname, "..", "drizzle") });
		identityChain = new RecordingIdentityChainClient([REGISTERED, CLAIMANT]);
		app = await buildApp({
			config,
			db,
			identityChain,
			logger: false,
			startBoss: false,
		});

		await mirrorHandle(db, "alice", REGISTERED);
		await mirrorHandle(db, "newbie", UNREGISTERED);
	}, 120_000);

	afterAll(async () => {
		await app?.close();
		await pool?.end();
		await container?.stop();
	});

	it("resolves raw addresses with eERC registration status", async () => {
		const registeredResponse = await app.inject({
			method: "POST",
			payload: { address: REGISTERED },
			url: "/transfers/resolve-recipient",
		});
		const unregisteredResponse = await app.inject({
			method: "POST",
			payload: { address: UNREGISTERED },
			url: "/transfers/resolve-recipient",
		});

		expect(registeredResponse.statusCode).toBe(200);
		expect(registeredResponse.json()).toEqual({
			address: REGISTERED.toLowerCase(),
			canReceivePrivately: true,
			registeredOnEerc: true,
		});
		expect(unregisteredResponse.statusCode).toBe(200);
		expect(unregisteredResponse.json()).toEqual({
			address: UNREGISTERED.toLowerCase(),
			canReceivePrivately: false,
			registeredOnEerc: false,
		});
	});

	it("resolves cached handles without chain handle resolution", async () => {
		const response = await app.inject({
			method: "POST",
			payload: { handle: "@alice" },
			url: "/transfers/resolve-recipient",
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			address: REGISTERED.toLowerCase(),
			canReceivePrivately: true,
			registeredOnEerc: true,
		});
		expect(identityChain.resolveCalls).toBe(0);
	});

	it("rejects ambiguous, invalid, missing, and unavailable recipients", async () => {
		const ambiguousResponse = await app.inject({
			method: "POST",
			payload: { address: REGISTERED, handle: "alice" },
			url: "/transfers/resolve-recipient",
		});
		const invalidHandleResponse = await app.inject({
			method: "POST",
			payload: { handle: "no" },
			url: "/transfers/resolve-recipient",
		});
		const missingHandleResponse = await app.inject({
			method: "POST",
			payload: { handle: "missing" },
			url: "/transfers/resolve-recipient",
		});

		identityChain.failRegistration = true;
		const unavailableResponse = await app.inject({
			method: "POST",
			payload: { address: REGISTERED },
			url: "/transfers/resolve-recipient",
		});
		identityChain.failRegistration = false;

		expect(ambiguousResponse.statusCode).toBe(400);
		expect(ambiguousResponse.json()).toEqual({ error: "invalid_recipient" });
		expect(invalidHandleResponse.statusCode).toBe(400);
		expect(invalidHandleResponse.json()).toEqual({ error: "invalid_handle" });
		expect(missingHandleResponse.statusCode).toBe(404);
		expect(missingHandleResponse.json()).toEqual({
			error: "recipient_not_found",
		});
		expect(unavailableResponse.statusCode).toBe(503);
		expect(unavailableResponse.json()).toEqual({
			error: "registration_status_unavailable",
		});
	});

	it("rejects an @-prefixed handle below the minimum length like the bare handle", async () => {
		const prefixedResponse = await app.inject({
			method: "POST",
			payload: { handle: "@ab" },
			url: "/transfers/resolve-recipient",
		});
		const bareResponse = await app.inject({
			method: "POST",
			payload: { handle: "ab" },
			url: "/transfers/resolve-recipient",
		});

		expect(prefixedResponse.statusCode).toBe(400);
		expect(prefixedResponse.json()).toEqual({ error: "invalid_handle" });
		expect(bareResponse.statusCode).toBe(400);
		expect(bareResponse.json()).toEqual({ error: "invalid_handle" });
	});

	it("rejects a reserved handle like the identity API", async () => {
		const prefixedResponse = await app.inject({
			method: "POST",
			payload: { handle: "@admin" },
			url: "/transfers/resolve-recipient",
		});
		const bareResponse = await app.inject({
			method: "POST",
			payload: { handle: "admin" },
			url: "/transfers/resolve-recipient",
		});

		expect(prefixedResponse.statusCode).toBe(400);
		expect(prefixedResponse.json()).toEqual({ error: "reserved_handle" });
		expect(bareResponse.statusCode).toBe(400);
		expect(bareResponse.json()).toEqual({ error: "reserved_handle" });
	});

	it("rejects an invite that specifies both a public giftAmount and a private escrow reference", async () => {
		const creatorCookie = await session(db, config, CREATOR);

		const response = await app.inject({
			headers: { cookie: creatorCookie },
			method: "POST",
			payload: {
				escrowGiftId: "7",
				escrowKind: "private",
				giftAmount: "10",
				kind: "gift",
			},
			url: "/invites",
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_invite" });
	});

	it("surfaces private gift escrow metadata through invite create, fetch, and claim", async () => {
		const creatorCookie = await session(db, config, CREATOR);
		const claimantCookie = await session(db, config, CLAIMANT);

		const createResponse = await app.inject({
			headers: { cookie: creatorCookie },
			method: "POST",
			payload: {
				escrowGiftId: "42",
				escrowKind: "private",
				kind: "gift",
				note: "Private gift ready",
			},
			url: "/invites",
		});

		expect(createResponse.statusCode).toBe(201);
		const createBody = createResponse.json<{
			invite: {
				escrowGiftId: string;
				escrowKind: string;
				id: string;
				kind: string;
			};
			token: string;
		}>();
		expect(createBody.invite).toMatchObject({
			escrowGiftId: "42",
			escrowKind: "private",
			kind: "gift",
		});
		expect(createBody.token).toEqual(expect.any(String));

		const [storedInvite] = await db
			.select({
				escrowGiftId: invites.escrowGiftId,
				escrowKind: invites.escrowKind,
			})
			.from(invites)
			.where(eq(invites.id, createBody.invite.id))
			.limit(1);
		expect(storedInvite).toEqual({
			escrowGiftId: "42",
			escrowKind: "private",
		});

		const fetchResponse = await app.inject({
			method: "GET",
			url: `/invites/${createBody.token}`,
		});
		expect(fetchResponse.statusCode).toBe(200);
		expect(fetchResponse.json()).toMatchObject({
			invite: {
				escrowGiftId: "42",
				escrowKind: "private",
				kind: "gift",
				status: "created",
			},
		});
		expect(fetchResponse.body).not.toContain(createBody.token);

		const claimResponse = await app.inject({
			headers: { cookie: claimantCookie },
			method: "POST",
			url: `/invites/${createBody.token}/claim`,
		});
		expect(claimResponse.statusCode).toBe(200);
		expect(claimResponse.json()).toMatchObject({
			claimant: {
				address: CLAIMANT.toLowerCase(),
				registeredOnEerc: true,
			},
			invite: {
				escrowGiftId: "42",
				escrowKind: "private",
				kind: "gift",
				status: "claimed",
			},
		});
	});
});

async function mirrorHandle(
	db: Database,
	handle: string,
	address: string,
): Promise<void> {
	const [user] = await db
		.insert(users)
		.values({ address: address.toLowerCase(), roles: [] })
		.onConflictDoUpdate({
			set: { address: address.toLowerCase() },
			target: users.address,
		})
		.returning({ id: users.id });

	if (!user) {
		throw new Error("test_user_insert_failed");
	}

	await db.insert(handles).values({ handle, userId: user.id });
}

async function session(
	db: Database,
	config: ApiConfig,
	address: string,
): Promise<string> {
	const [user] = await db
		.insert(users)
		.values({ address: address.toLowerCase(), roles: [] })
		.onConflictDoUpdate({
			set: { address: address.toLowerCase() },
			target: users.address,
		})
		.returning({ id: users.id });

	if (!user) {
		throw new Error("test_user_insert_failed");
	}

	const sessionId = randomUUID();
	await db.insert(sessions).values({
		expiresAt: new Date(Date.now() + 86_400_000),
		id: sessionId,
		userId: user.id,
	});

	return `${config.sessionCookieName}=${sessionId}`;
}

class RecordingIdentityChainClient implements IdentityChainClient {
	failRegistration = false;
	resolveCalls = 0;
	readonly #registeredAddresses = new Set<string>();

	constructor(registeredAddresses: string[]) {
		for (const address of registeredAddresses) {
			this.#registeredAddresses.add(address.toLowerCase());
		}
	}

	async claimHandle(): Promise<ClaimedHandle> {
		throw new Error("claim unavailable");
	}

	async getRegistrationStatuses(
		addresses: string[],
	): Promise<Map<string, boolean>> {
		if (this.failRegistration) {
			throw new Error("registration unavailable");
		}

		return new Map(
			addresses.map((address) => [
				address.toLowerCase(),
				this.#registeredAddresses.has(address.toLowerCase()),
			]),
		);
	}

	async resolveHandle(): Promise<HandleResolution> {
		this.resolveCalls += 1;
		throw new Error("resolve should not be called");
	}
}
