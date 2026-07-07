import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
	createAuditorKeypair,
	encryptAuditorAmountPct,
} from "../src/auditor/crypto.js";
import { listAuditorEvents } from "../src/auditor/service.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { sealString, unsealString } from "../src/crypto/seal.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import {
	auditorKeys,
	events,
	orgMembers,
	orgs,
	orgTreasuries,
	users,
} from "../src/db/schema.js";
import {
	createManagedEercAccount,
	serializeManagedEercAccount,
} from "../src/payroll/eerc.js";

const testMasterKey =
	"0000000000000000000000000000000000000000000000000000000000000000";

type EventBackupRow = typeof events.$inferInsert;

type LogicalBackup = {
	auditorKeys: (typeof auditorKeys.$inferSelect)[];
	events: EventBackupRow[];
	orgMembers: (typeof orgMembers.$inferSelect)[];
	orgTreasuries: (typeof orgTreasuries.$inferSelect)[];
	orgs: (typeof orgs.$inferSelect)[];
	users: (typeof users.$inferSelect)[];
};

type SeededRecoveryFixture = {
	amount: bigint;
	eercSecret: string;
	eoaPrivateKey: string;
	subject: string;
	treasuryAddress: string;
	txHash: `0x${string}`;
};

describe("@benzo/api restore drill", () => {
	it(
		"recovers managed treasury funds and auditor decryptability from restored Postgres plus APP_MASTER_KEY escrow",
		{ timeout: 180_000 },
		async () => {
			let sourcePostgres: StartedPostgreSqlContainer | undefined;
			let restoredPostgres: StartedPostgreSqlContainer | undefined;
			let sourcePool: ReturnType<typeof createPool> | undefined;
			let restoredPool: ReturnType<typeof createPool> | undefined;

			try {
				[sourcePostgres, restoredPostgres] = await Promise.all([
					new PostgreSqlContainer("postgres:17-alpine")
						.withDatabase("benzo_restore_source")
						.withUsername("benzo")
						.withPassword("benzo")
						.start(),
					new PostgreSqlContainer("postgres:17-alpine")
						.withDatabase("benzo_restore_target")
						.withUsername("benzo")
						.withPassword("benzo")
						.start(),
				]);

				const sourceConfig = baseConfig(sourcePostgres.getConnectionUri());
				const escrowedMasterKey = testMasterKey;
				const restoredConfig = baseConfig(
					restoredPostgres.getConnectionUri(),
					escrowedMasterKey,
				);

				await Promise.all([
					migrateDatabase(sourceConfig),
					migrateDatabase(restoredConfig),
				]);

				sourcePool = createPool(sourceConfig);
				restoredPool = createPool(restoredConfig);
				const sourceDb = createDb(sourcePool);
				const restoredDb = createDb(restoredPool);

				const seeded = await seedSourceDatabase(sourceDb, sourceConfig);
				const backup = await exportLogicalBackup(sourceDb);

				await restoreLogicalBackup(restoredDb, backup);

				const [treasury] = await restoredDb
					.select()
					.from(orgTreasuries)
					.where(eq(orgTreasuries.address, seeded.treasuryAddress))
					.limit(1);

				expect(treasury).toBeDefined();
				expect(unsealString(escrowedMasterKey, treasury!.sealedEoaKey)).toBe(
					seeded.eoaPrivateKey,
				);
				expect(treasury!.sealedEercKey).not.toBeNull();
				expect(
					unsealString(escrowedMasterKey, treasury!.sealedEercKey!),
				).toBe(seeded.eercSecret);

				const restoredAuditorEvents = await listAuditorEvents(
					restoredDb,
					restoredConfig,
					{
						actor: normalizeAddress("0x7777777777777777777777777777777777777777"),
						address: seeded.subject,
						limit: 10,
						offset: 0,
					},
				);

				expect(restoredAuditorEvents.events).toMatchObject([
					{
						amount: seeded.amount.toString(),
						blockNumber: "50",
						txHash: seeded.txHash,
					},
				]);

				// Assert the actual backed-up rows survived the restore — not the
				// audit_log row that the post-restore listAuditorEvents() call above
				// just wrote as a side effect (that would prove nothing about the
				// backup). The auditor key + the encrypted transfer are what a real
				// recovery must bring back.
				const [restoredEvent] = await restoredDb
					.select()
					.from(events)
					.where(eq(events.txHash, seeded.txHash))
					.limit(1);
				expect(restoredEvent).toBeDefined();
				expect(restoredEvent?.blockNumber).toBe(50n);

				const restoredKeys = await restoredDb.select().from(auditorKeys);
				expect(restoredKeys.length).toBeGreaterThan(0);
			} finally {
				await restoredPool?.end();
				await sourcePool?.end();
				await restoredPostgres?.stop();
				await sourcePostgres?.stop();
			}
		},
	);
});

function baseConfig(
	databaseUrl: string,
	appMasterKey = testMasterKey,
): ApiConfig {
	return {
		appMasterKey,
		apiDomain: "localhost",
		benzonetChainId: 43_113,
		benzonetRpcUrl: "http://127.0.0.1:1",
		chainEnv: "fuji",
		corsOrigins: [...DEFAULT_CORS_ORIGINS],
		databaseUrl,
		dripBalanceThresholdWei: 500_000_000_000_000_000n,
		dripWei: 500_000_000_000_000_000n,
		eercDeploymentManifest: undefined,
		eercEncryptedErcAddress: "0x46688f1704a69a6c276cccb823e36c80787b0fa2",
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

async function migrateDatabase(config: ApiConfig): Promise<void> {
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

async function seedSourceDatabase(
	db: Database,
	config: ApiConfig,
): Promise<SeededRecoveryFixture> {
	const eoaPrivateKey = generatePrivateKey();
	const treasuryAccount = privateKeyToAccount(eoaPrivateKey);
	const eercSecret = serializeManagedEercAccount(createManagedEercAccount(777n));
	const ownerAddress = normalizeAddress(privateKeyToAccount(generatePrivateKey()).address);
	const subject = normalizeAddress("0x7777777777777777777777777777777777777773");
	const counterparty = normalizeAddress("0x7777777777777777777777777777777777777774");
	const auditor = createAuditorKeypair(101n);
	const amount = 123_456n;
	const txHash = hashForId(47);

	const [owner] = await db
		.insert(users)
		.values({ address: ownerAddress, roles: [] })
		.returning({ id: users.id });
	const [org] = await db
		.insert(orgs)
		.values({ name: "Restore Drill Co", slug: "restore-drill-co" })
		.returning({ id: orgs.id });

	await db.insert(orgMembers).values({
		orgId: org!.id,
		role: "owner",
		userId: owner!.id,
	});
	await db.insert(orgTreasuries).values({
		address: treasuryAccount.address.toLowerCase(),
		consentedAt: new Date("2026-07-07T00:00:00Z"),
		consentedBy: owner!.id,
		orgId: org!.id,
		sealedEercKey: sealString(config.appMasterKey, eercSecret),
		sealedEoaKey: sealString(config.appMasterKey, eoaPrivateKey),
	});
	await db.insert(auditorKeys).values({
		activatedBlockNumber: 0n,
		active: true,
		publicKeyX: auditor.publicKey[0],
		publicKeyY: auditor.publicKey[1],
		sealedKey: sealString(config.appMasterKey, auditor.privateKey),
	});
	await db.insert(events).values({
		amountPct: encryptAuditorAmountPct(amount, auditor.publicKey),
		blockHash: hashForId(50),
		blockNumber: 50n,
		blockTime: new Date("2026-07-07T00:01:00Z"),
		contract: config.eercEncryptedErcAddress,
		eventName: "PrivateTransfer",
		fromAddr: subject,
		logIndex: 0,
		rawLog: {
			address: config.eercEncryptedErcAddress,
			data: "0x",
			topics: [],
		},
		toAddr: counterparty,
		transactionIndex: 0,
		txHash,
	});

	return {
		amount,
		eercSecret,
		eoaPrivateKey,
		subject,
		treasuryAddress: treasuryAccount.address.toLowerCase(),
		txHash,
	};
}

async function exportLogicalBackup(db: Database): Promise<LogicalBackup> {
	const eventRows = await db.select().from(events);

	return {
		auditorKeys: await db.select().from(auditorKeys),
		events: eventRows.map((row) => ({
			amountPct: row.amountPct,
			blockHash: row.blockHash,
			blockNumber: row.blockNumber,
			blockTime: row.blockTime,
			contract: row.contract,
			eventName: row.eventName,
			fromAddr: row.fromAddr,
			logIndex: row.logIndex,
			rawLog: row.rawLog,
			toAddr: row.toAddr,
			transactionIndex: row.transactionIndex,
			txHash: row.txHash,
		})),
		orgMembers: await db.select().from(orgMembers),
		orgTreasuries: await db.select().from(orgTreasuries),
		orgs: await db.select().from(orgs),
		users: await db.select().from(users),
	};
}

async function restoreLogicalBackup(
	db: Database,
	backup: LogicalBackup,
): Promise<void> {
	await db.insert(users).values(backup.users);
	await db.insert(orgs).values(backup.orgs);
	await db.insert(orgMembers).values(backup.orgMembers);
	await db.insert(orgTreasuries).values(backup.orgTreasuries);
	await db.insert(auditorKeys).values(backup.auditorKeys);
	await db.insert(events).values(backup.events);
}

function normalizeAddress(address: string): string {
	return getAddress(address).toLowerCase();
}

function hashForId(id: number): `0x${string}` {
	return `0x${id.toString(16).padStart(64, "0")}`;
}
