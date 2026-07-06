import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { unsealString } from "../src/crypto/seal.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import {
	handles,
	orgTreasuries,
	payrollItems,
	sessions,
	users,
} from "../src/db/schema.js";

const testMasterKey =
	"0000000000000000000000000000000000000000000000000000000000000000";

function baseConfig(databaseUrl: string): ApiConfig {
	return {
		appMasterKey: testMasterKey,
		apiDomain: "localhost",
		benzonetChainId: 43_113,
		benzonetRpcUrl: "http://127.0.0.1:1",
		chainEnv: "fuji",
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
		port: 0,
		sessionCookieName: "benzo_test_session",
		sessionTtlDays: 7,
		siweNonceTtlMinutes: 10,
	};
}

async function session(
	db: Database,
	config: ApiConfig,
	address: string,
): Promise<string> {
	const [user] = await db
		.insert(users)
		.values({ address, roles: [] })
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

describe("@benzo/api orgs", () => {
	let postgres: StartedPostgreSqlContainer;
	let config: ApiConfig;

	beforeAll(async () => {
		postgres = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_orgs_test")
			.withUsername("benzo")
			.withPassword("benzo")
			.start();
		config = baseConfig(postgres.getConnectionUri());
		const pool = createPool(config);
		const db = createDb(pool);
		try {
			await migrate(db, {
				migrationsFolder: path.resolve(
					path.dirname(fileURLToPath(import.meta.url)),
					"../drizzle",
				),
			});
		} finally {
			await pool.end();
		}
	});

	afterAll(async () => {
		await postgres.stop();
	});

	it("creates an org with the creator as owner and scopes membership", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, logger: false, startBoss: false });
		const owner = `0x${"a1".repeat(20)}`;
		const outsider = `0x${"b2".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const outsiderCookie = await session(db, config, outsider);

			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Acme Inc", slug: "acme" },
			});
			expect(created.statusCode).toBe(201);
			const orgId = created.json().org.id as string;
			expect(created.json().role).toBe("owner");

			const list = await app.inject({
				headers: { cookie: ownerCookie },
				method: "GET",
				url: "/orgs",
			});
			expect(list.json().orgs).toMatchObject([{ id: orgId, role: "owner" }]);

			// A non-member gets 404 (existence not leaked), and sees no orgs.
			const forbidden = await app.inject({
				headers: { cookie: outsiderCookie },
				method: "GET",
				url: `/orgs/${orgId}`,
			});
			expect(forbidden.statusCode).toBe(404);
			const outsiderList = await app.inject({
				headers: { cookie: outsiderCookie },
				method: "GET",
				url: "/orgs",
			});
			expect(outsiderList.json().orgs).toEqual([]);

			// A duplicate slug is a 409, not a 500 from the unique constraint.
			const dupe = await app.inject({
				headers: { cookie: outsiderCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Acme Rival", slug: "acme" },
			});
			expect(dupe.statusCode).toBe(409);
			expect(dupe.json().error).toBe("slug_taken");
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("enforces role rank on member management and treasury provisioning", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, logger: false, startBoss: false });
		const owner = `0x${"c3".repeat(20)}`;
		const operator = `0x${"d4".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const operatorCookie = await session(db, config, operator);

			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Beta", slug: "beta" },
			});
			const orgId = created.json().org.id as string;

			// Owner adds the operator as an 'operator'.
			const addOperator = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/members`,
				payload: { address: operator, role: "operator" },
			});
			expect(addOperator.statusCode).toBe(201);

			// Operator (rank 1) cannot add members (needs admin, rank 2). The role
			// gate runs in the preHandler, before the body is inspected, so the
			// operator is forbidden regardless of the target.
			const operatorAdds = await app.inject({
				headers: { cookie: operatorCookie },
				method: "POST",
				url: `/orgs/${orgId}/members`,
				payload: { address: owner, role: "viewer" },
			});
			expect(operatorAdds.statusCode).toBe(403);

			// Operator cannot provision the treasury (needs admin).
			const operatorTreasury = await app.inject({
				headers: { cookie: operatorCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});
			expect(operatorTreasury.statusCode).toBe(403);

			// An admin may not demote the owner (who outranks them and could never
			// be restored, since "owner" isn't a settable role).
			const admin = `0x${"e5".repeat(20)}`;
			const adminCookie = await session(db, config, admin);
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/members`,
				payload: { address: admin, role: "admin" },
			});
			const adminDemotesOwner = await app.inject({
				headers: { cookie: adminCookie },
				method: "POST",
				url: `/orgs/${orgId}/members`,
				payload: { address: owner, role: "operator" },
			});
			expect(adminDemotesOwner.statusCode).toBe(403);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("provisions a treasury only with consent and seals the key at rest", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, logger: false, startBoss: false });
		const owner = `0x${"f6".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Gamma", slug: "gamma" },
			});
			const orgId = created.json().org.id as string;

			// Without consent → 400.
			const noConsent = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: {},
			});
			expect(noConsent.statusCode).toBe(400);
			expect(noConsent.json().error).toBe("consent_required");

			// With consent → 201, returns address, custody managed, not yet registered.
			const provisioned = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});
			expect(provisioned.statusCode).toBe(201);
			const address = provisioned.json().address as string;
			expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
			expect(provisioned.json()).toMatchObject({
				custody: "managed",
				consented: true,
				registered: false,
			});

			// The sealed EOA key must not be plaintext, and must unseal (only with
			// the master key) back to the private key that derives the treasury.
			const [row] = await db
				.select({ sealedEoaKey: orgTreasuries.sealedEoaKey })
				.from(orgTreasuries)
				.where(eq(orgTreasuries.orgId, orgId))
				.limit(1);
			expect(row).toBeDefined();
			const sealed = row!.sealedEoaKey;
			// Raw bytes are not a usable 0x private key string.
			expect(sealed.toString("utf8")).not.toMatch(/^0x[0-9a-fA-F]{64}$/);
			const recoveredKey = unsealString(config.appMasterKey, sealed);
			expect(recoveredKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
			expect(privateKeyToAccount(recoveredKey as `0x${string}`).address).toBe(
				address,
			);

			// A second provisioning is a conflict.
			const second = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});
			expect(second.statusCode).toBe(409);

			// Custody status endpoint never returns key material.
			const status = await app.inject({
				headers: { cookie: ownerCookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury`,
			});
			expect(status.json()).toMatchObject({
				address,
				custody: "managed",
				consented: true,
				registered: false,
			});
			expect(JSON.stringify(status.json())).not.toContain(recoveredKey);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("validates a payroll CSV into a ready run and flags bad rows", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, logger: false, startBoss: false });
		const owner = `0x${"11".repeat(20)}`;
		const aliceAddr = `0x${"22".repeat(20)}`;
		const rawAddr = `0x${"be".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			// Register @alice as a handle so the CSV can resolve it.
			const [alice] = await db
				.insert(users)
				.values({ address: aliceAddr, roles: [] })
				.returning({ id: users.id });
			await db.insert(handles).values({ handle: "alice", userId: alice!.id });

			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Payco", slug: "payco" },
			});
			const orgId = created.json().org.id as string;

			const csv = [
				"recipient,amount", // header — skipped
				`@alice,100.50`, // valid → alice
				`${rawAddr},25`, // valid → raw address
				`@nobody,10`, // unknown handle
				`@alice,5`, // duplicate of alice
				`0x${"ca".repeat(20)},abc`, // invalid amount
			].join("\n");

			const res = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/payroll`,
				payload: { csv },
			});
			expect(res.statusCode).toBe(201);
			const preview = res.json();
			expect(preview.status).toBe("ready");
			expect(preview.summary).toMatchObject({
				total: 5,
				valid: 2,
				invalid: 3,
				totalAmount: "125.5",
			});
			// Per-row verdicts.
			const byRow = Object.fromEntries(
				preview.items.map((i: { rowIndex: number }) => [i.rowIndex, i]),
			);
			expect(byRow[0]).toMatchObject({
				status: "pending",
				resolvedAddress: aliceAddr,
			});
			expect(byRow[1]).toMatchObject({ status: "pending", resolvedAddress: rawAddr });
			expect(byRow[2]).toMatchObject({ status: "failed", error: "unknown_recipient" });
			expect(byRow[3]).toMatchObject({ status: "failed", error: "duplicate_recipient" });
			expect(byRow[4]).toMatchObject({ status: "failed", error: "invalid_amount" });

			// Persisted: GET returns the run + all rows, ordered.
			const runId = preview.runId as string;
			const persistedItems = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.runId, runId));
			expect(persistedItems).toHaveLength(5);

			const getRun = await app.inject({
				headers: { cookie: ownerCookie },
				method: "GET",
				url: `/payroll/${runId}`,
			});
			expect(getRun.statusCode).toBe(200);
			expect(getRun.json().run).toMatchObject({ status: "ready", itemCount: 2 });

			// A non-member can't see the run (404, existence not leaked).
			const outsiderCookie = await session(db, config, `0x${"99".repeat(20)}`);
			const forbidden = await app.inject({
				headers: { cookie: outsiderCookie },
				method: "GET",
				url: `/payroll/${runId}`,
			});
			expect(forbidden.statusCode).toBe(404);
		} finally {
			await app.close();
			await pool.end();
		}
	});
});
