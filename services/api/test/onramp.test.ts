import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { decodeAbiParameters, getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import { sessions, users } from "../src/db/schema.js";
import type { OnrampChainClient } from "../src/onramp/chain.js";
import { encodeOnrampHookData } from "../src/onramp/hookdata.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTERED = getAddress("0x1111111111111111111111111111111111111111");
const UNREGISTERED = getAddress("0x2222222222222222222222222222222222222222");
const ROUTER = getAddress("0x00000000000000000000000000000000000000aa");
const PK_X = 123n;
const PK_Y = 456n;

function testConfig(databaseUrl: string): ApiConfig {
	return {
		appMasterKey:
			"0000000000000000000000000000000000000000000000000000000000000000",
		apiDomain: "localhost",
		benzonetChainId: 43_113,
		benzonetRpcUrl: "http://127.0.0.1:1",
		chainEnv: "fuji",
		autoDepositRouterAddress: ROUTER,
		cctpAttestationApiBase: "https://iris-api-sandbox.circle.com",
		cctpDomain: 1,
		cctpMessageTransmitter: "0xe737e5cebeeba77efe34d4aa090756590b1ce275",
		cctpTokenMessenger: "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa",
		tier: "staging",
		corsOrigins: [...DEFAULT_CORS_ORIGINS],
		databaseUrl,
		dripBalanceThresholdWei: 500_000_000_000_000_000n,
		dripWei: 500_000_000_000_000_000n,
		eercDeploymentManifest: undefined,
		eercEncryptedErcAddress: "0x9e16ed3b799541b4929f7e2014904c65e81035b1",
		eercRegistrarAddress: "0x9a63fea9851097dbaf3757b636217fdde50abaf0",
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
		opsPrivateKey:
			"0x0000000000000000000000000000000000000000000000000000000000000001",
		payrollEercDecimals: 6,
		payrollTokenId: 1n,
		payrollZkArtifactDir: "/tmp/benzo-test-zk-artifacts",
		port: 0,
		sessionCookieName: "benzo_test_session",
		sessionTtlDays: 7,
		siweNonceTtlMinutes: 10,
	};
}

// Stub destination-chain reader: only REGISTERED resolves to a public key.
const onrampChain: OnrampChainClient = {
	async resolveUserKey(address) {
		return getAddress(address) === REGISTERED
			? { registered: true, publicKey: [PK_X, PK_Y] }
			: { registered: false, publicKey: null };
	},
};

async function session(
	db: Database,
	config: ApiConfig,
	address: string,
): Promise<string> {
	const [user] = await db
		.insert(users)
		.values({ address: address.toLowerCase(), roles: [] })
		.onConflictDoUpdate({ set: { roles: [] }, target: users.address })
		.returning({ id: users.id });
	const sessionId = randomUUID();
	await db.insert(sessions).values({
		expiresAt: new Date(Date.now() + 86_400_000),
		id: sessionId,
		userId: user!.id,
	});
	return `${config.sessionCookieName}=${sessionId}`;
}

describe("onramp intents", () => {
	let container: StartedPostgreSqlContainer;
	let db: Database;
	let pool: ReturnType<typeof createPool>;
	let config: ApiConfig;
	let app: Awaited<ReturnType<typeof buildApp>>;

	beforeAll(async () => {
		container = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_onramp_test")
			.withUsername("benzo")
			.start();
		config = testConfig(container.getConnectionUri());
		pool = createPool(config);
		db = createDb(pool);
		await migrate(db, { migrationsFolder: path.join(dirname, "..", "drizzle") });
		app = await buildApp({ config, db, logger: false, onrampChain, startBoss: false });
	}, 120_000);

	afterAll(async () => {
		await app?.close();
		await pool?.end();
		await container?.stop();
	});

	it("hookData round-trips (address, pkX, pkY)", () => {
		const hookData = encodeOnrampHookData({ user: REGISTERED, pkX: PK_X, pkY: PK_Y });
		expect(hookData).toMatch(/^0x[0-9a-f]+$/i);
		// abi.encode(address,uint256,uint256) == 3 * 32 bytes.
		expect((hookData.length - 2) / 2).toBe(96);
		const [user, x, y] = decodeAbiParameters(
			[{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
			hookData,
		);
		expect(getAddress(user)).toBe(REGISTERED);
		expect(x).toBe(PK_X);
		expect(y).toBe(PK_Y);
	});

	it("POST /onramp/quote returns signable burn params for a registered user", async () => {
		const cookie = await session(db, config, REGISTERED);
		const res = await app.inject({
			method: "POST",
			url: "/onramp/quote",
			headers: { cookie },
			payload: { token: "usdc" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.destinationDomain).toBe(1);
		expect(getAddress(body.tokenMessenger)).toBe(
			getAddress("0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa"),
		);
		// mintRecipient + destinationCaller are the router, left-padded to bytes32.
		const expectedBytes32 = `0x${"00".repeat(12)}${ROUTER.slice(2).toLowerCase()}`;
		expect(body.mintRecipient.toLowerCase()).toBe(expectedBytes32);
		expect(body.destinationCaller.toLowerCase()).toBe(expectedBytes32);
		// hookData decodes back to the caller + their registered key.
		const [user] = decodeAbiParameters([{ type: "address" }], body.hookData as `0x${string}`);
		expect(getAddress(user)).toBe(REGISTERED);
	});

	it("POST /onramp/quote is 409 for an un-registered user", async () => {
		const cookie = await session(db, config, UNREGISTERED);
		const res = await app.inject({
			method: "POST",
			url: "/onramp/quote",
			headers: { cookie },
			payload: {},
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().error).toBe("not_eerc_registered");
	});

	it("POST /onramp/intents persists a pending intent for a registered user", async () => {
		const cookie = await session(db, config, REGISTERED);
		const res = await app.inject({
			method: "POST",
			url: "/onramp/intents",
			headers: { cookie },
			payload: {
				sourceDomain: 0, // Ethereum Sepolia (USDC source)
				sourceTxHash: `0x${"ab".repeat(32)}`,
				token: "usdc",
			},
		});
		expect(res.statusCode).toBe(201);
		const { intent } = res.json();
		expect(intent.status).toBe("initiated");
		expect(intent.destToken).toBe("usdc");

		// It is retrievable and the list endpoint returns it.
		const list = await app.inject({
			method: "GET",
			url: "/onramp/intents",
			headers: { cookie },
		});
		expect(list.statusCode).toBe(200);
		expect(list.json().intents.length).toBeGreaterThanOrEqual(1);
	});

	it("POST /onramp/intents rejects a user not eERC-registered on the destination", async () => {
		const cookie = await session(db, config, UNREGISTERED);
		const res = await app.inject({
			method: "POST",
			url: "/onramp/intents",
			headers: { cookie },
			payload: {
				sourceDomain: 0,
				sourceTxHash: `0x${"cd".repeat(32)}`,
				token: "usdc",
			},
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().error).toBe("not_eerc_registered");
	});
});
