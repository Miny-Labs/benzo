import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../src/db/client.js";
import { orgs, treasuryDeposits } from "../src/db/schema.js";
import {
	reconcileTreasuryDeposits,
	type TreasuryReceiptClient,
} from "../src/treasury/reconciler.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

describe("treasury deposit reconciler", () => {
	let container: StartedPostgreSqlContainer;
	let db: Database;
	let pool: Pool;

	beforeAll(async () => {
		container = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_treasury_reconciler_test")
			.withUsername("benzo")
			.withPassword("benzo")
			.start();
		pool = new Pool({ connectionString: container.getConnectionUri() });
		db = createDb(pool);
		await migrate(db, {
			migrationsFolder: path.join(dirname, "..", "drizzle"),
		});
	});

	afterAll(async () => {
		await pool?.end();
		await container?.stop();
	});

	it("settles confirmed and reverted receipts, leaves unmined rows submitted, and is idempotent", async () => {
		const orgId = await insertOrg(db);
		const now = Date.UTC(2026, 0, 1);
		const old = new Date(now - 120_000);
		const confirmedHash = txHash(1);
		const failedHash = txHash(2);
		const unminedHash = txHash(3);

		await insertDeposit(db, {
			orgId,
			txHash: confirmedHash,
			updatedAt: old,
		});
		await insertDeposit(db, {
			orgId,
			txHash: failedHash,
			updatedAt: old,
		});
		await insertDeposit(db, {
			orgId,
			txHash: unminedHash,
			updatedAt: old,
		});

		const receiptClient: TreasuryReceiptClient = {
			async getTransactionReceipt({ hash }) {
				if (hash === confirmedHash) {
					return { status: 1 };
				}
				if (hash === failedHash) {
					return { status: 0 };
				}
				if (hash === unminedHash) {
					const error = new Error(
						`Transaction receipt with hash ${hash} could not be found.`,
					);
					error.name = "TransactionReceiptNotFoundError";
					throw error;
				}

				throw new Error(`unexpected_receipt_lookup:${hash}`);
			},
		};

		await expect(
			reconcileTreasuryDeposits(db, {
				graceMs: 90_000,
				now: () => now,
				receiptClient,
			}),
		).resolves.toEqual({
			confirmed: 1,
			failed: 1,
			pending: 1,
			polled: 3,
			skipped: 0,
		});

		await expect(statusForHash(db, confirmedHash)).resolves.toBe("confirmed");
		await expect(statusForHash(db, failedHash)).resolves.toBe("failed");
		await expect(statusForHash(db, unminedHash)).resolves.toBe("submitted");

		await expect(
			reconcileTreasuryDeposits(db, {
				graceMs: 90_000,
				now: () => now,
				receiptClient,
			}),
		).resolves.toEqual({
			confirmed: 0,
			failed: 0,
			pending: 1,
			polled: 1,
			skipped: 0,
		});

		await expect(statusForHash(db, confirmedHash)).resolves.toBe("confirmed");
		await expect(statusForHash(db, failedHash)).resolves.toBe("failed");
		await expect(statusForHash(db, unminedHash)).resolves.toBe("submitted");
	});
});

async function insertOrg(db: Database): Promise<string> {
	const id = randomUUID();
	await db.insert(orgs).values({
		id,
		name: "Treasury Reconciler Test",
		slug: `treasury-reconciler-${id}`,
	});
	return id;
}

async function insertDeposit(
	db: Database,
	input: {
		orgId: string;
		txHash: Hex;
		updatedAt: Date;
	},
): Promise<void> {
	await db.insert(treasuryDeposits).values({
		amount: "1000000",
		createdAt: input.updatedAt,
		idempotencyKey: randomUUID(),
		orgId: input.orgId,
		source: "direct",
		status: "submitted",
		token: "usdc",
		tokenId: 1n,
		txHash: input.txHash,
		updatedAt: input.updatedAt,
	});
}

async function statusForHash(db: Database, hash: Hex) {
	const [row] = await db
		.select({ status: treasuryDeposits.status })
		.from(treasuryDeposits)
		.where(eq(treasuryDeposits.txHash, hash));

	return row?.status ?? null;
}

function txHash(id: number): Hex {
	return `0x${id.toString(16).padStart(64, "0")}` as Hex;
}
