import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { decodeAbiParameters, getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { sealString } from "../src/crypto/seal.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import {
	onrampIntents,
	orgMembers,
	orgTreasuries,
	sessions,
	treasuryDeposits,
	users,
} from "../src/db/schema.js";
import type { OnrampChainClient } from "../src/onramp/chain.js";
import type { IrisClient } from "../src/onramp/cctp.js";
import { encodeOnrampHookData } from "../src/onramp/hookdata.js";
import { pollOnrampIntents } from "../src/onramp/poller.js";
import type { OnrampRelayer } from "../src/onramp/relayer.js";
import {
	createManagedEercAccount,
	serializeManagedEercAccount,
	type ManagedEercAccount,
} from "../src/payroll/eerc.js";

// Circle CCTP V2 staging constants (mirror @benzo/config) exercised by the burn
// params + poller assertions.
const ROUTER = getAddress("0x00000000000000000000000000000000000000aa");
const STAGING_TOKEN_MESSENGER = getAddress(
	"0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
);
const ETHEREUM_SEPOLIA_USDC = getAddress(
	"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
);
const BURN_TOKEN = getAddress("0x5425890298aed601595a70ab815c96711a31Bc65");
const FILLER = getAddress("0x3333333333333333333333333333333333333333");
const RELAYER_ADDRESS = getAddress("0x984E075152391C018Df97161D51C6BfE52631508");
const ATTESTATION = "0x1234" as Hex;

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
		cctpDestDomain: 1,
		cctpDomain: 1,
		cctpMessageTransmitter: "0xe737e5cebeeba77efe34d4aa090756590b1ce275",
		cctpTokenMessenger: STAGING_TOKEN_MESSENGER.toLowerCase(),
		tier: "staging",
		corsOrigins: [...DEFAULT_CORS_ORIGINS],
		databaseUrl,
		dripBalanceThresholdWei: 500_000_000_000_000_000n,
		dripWei: 500_000_000_000_000_000n,
		eercDeploymentManifest: undefined,
		eercConverterAddress: "0x9e16ed3b799541b4929f7e2014904c65e81035b1",
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
		treasuryFundingTokens: [
			{
				address: BURN_TOKEN.toLowerCase(),
				decimals: 6,
				symbol: "USDC",
				token: "usdc",
				tokenId: 1n,
			},
			{
				address: "0x5e44db7996c682e92a960b65ac713a54ad815c6b",
				decimals: 6,
				symbol: "EURC",
				token: "eurc",
				tokenId: 2n,
			},
		],
	};
}

async function session(
	db: Database,
	config: ApiConfig,
	address: string,
): Promise<{ cookie: string; userId: string }> {
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
	return { cookie: `${config.sessionCookieName}=${sessionId}`, userId: user!.id };
}

async function createOrg(
	app: Awaited<ReturnType<typeof buildApp>>,
	cookie: string,
): Promise<string> {
	const created = await app.inject({
		headers: { cookie },
		method: "POST",
		url: "/orgs",
		payload: { name: "Fund Co", slug: `fund-${randomUUID()}` },
	});
	return created.json().org.id as string;
}

async function provisionTreasury(
	db: Database,
	config: ApiConfig,
	orgId: string,
	consentedBy: string,
	eercAccount: ManagedEercAccount,
): Promise<string> {
	const eoaKey = generatePrivateKey();
	const account = privateKeyToAccount(eoaKey);
	await db.insert(orgTreasuries).values({
		address: account.address.toLowerCase(),
		consentedAt: new Date(),
		consentedBy,
		eercRegisteredAt: new Date(),
		orgId,
		sealedEercKey: sealString(
			config.appMasterKey,
			serializeManagedEercAccount(eercAccount),
		),
		sealedEoaKey: sealString(config.appMasterKey, eoaKey),
	});
	return getAddress(account.address);
}

// --- CCTP message assembly (mirrors the on-chain BurnMessageV2 layout). ---
function concatHex(parts: Hex[]): Hex {
	return `0x${parts.map((part) => part.slice(2)).join("")}` as Hex;
}

function uintHex(value: bigint | number, bytes: number): Hex {
	return `0x${BigInt(value).toString(16).padStart(bytes * 2, "0")}` as Hex;
}

function addressBytes32(address: string): Hex {
	return `0x${"00".repeat(12)}${getAddress(address).slice(2).toLowerCase()}` as Hex;
}

function buildCctpMessage(input: {
	amount: bigint;
	feeExecuted?: bigint;
	hookData: Hex;
	nonce: bigint;
	sourceDomain: number;
}): Hex {
	const body = concatHex([
		uintHex(1, 4),
		addressBytes32(BURN_TOKEN),
		addressBytes32(ROUTER),
		uintHex(input.amount, 32),
		addressBytes32(FILLER),
		uintHex(input.feeExecuted ?? 0n, 32),
		uintHex(input.feeExecuted ?? 0n, 32),
		uintHex(0, 32),
		input.hookData,
	]);
	return concatHex([
		uintHex(1, 4),
		uintHex(input.sourceDomain, 4),
		uintHex(1, 4),
		uintHex(input.nonce, 32),
		addressBytes32(STAGING_TOKEN_MESSENGER),
		addressBytes32(STAGING_TOKEN_MESSENGER),
		uintHex(0, 32),
		uintHex(1000, 4),
		uintHex(2000, 4),
		body,
	]);
}

function chainFor(
	registeredAddress: string,
	publicKey: [bigint, bigint],
): OnrampChainClient {
	return {
		async resolveUserKey(address) {
			return getAddress(address) === getAddress(registeredAddress)
				? { registered: true, publicKey }
				: { registered: false, publicKey: null };
		},
	};
}

function irisFor(sourceTxHash: string, message: Hex): IrisClient {
	return {
		async getMessages(_sourceDomain, txHash) {
			return txHash.toLowerCase() === sourceTxHash.toLowerCase()
				? [{ attestation: ATTESTATION, eventNonce: null, message, status: "complete" }]
				: [];
		},
	};
}

describe("@benzo/api cross-chain treasury funding", () => {
	let container: StartedPostgreSqlContainer;
	let config: ApiConfig;

	beforeAll(async () => {
		container = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_treasury_fund_test")
			.withUsername("benzo")
			.withPassword("benzo")
			.start();
		config = testConfig(container.getConnectionUri());
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
	}, 120_000);

	afterAll(async () => {
		await container?.stop();
	});

	it("returns per-source-chain burn params and rejects unsupported chain/token combos", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, db, logger: false, startBoss: false });
		try {
			const owner = await session(db, config, `0x${"a1".repeat(20)}`);
			const orgId = await createOrg(app, owner.cookie);
			const eercAccount = createManagedEercAccount(4_242n);
			const treasuryAddress = await provisionTreasury(
				db,
				config,
				orgId,
				owner.userId,
				eercAccount,
			);

			// Preview (no sourceTxHash): returns signable burn params, no intent.
			const preview = await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: { sourceChain: "ethereum", token: "usdc", amount: "1000000" },
			});
			expect(preview.statusCode).toBe(200);
			const { burn, fundIntent } = preview.json();
			expect(fundIntent).toBeUndefined();
			expect(burn.destinationDomain).toBe(1);
			expect(getAddress(burn.burnToken)).toBe(ETHEREUM_SEPOLIA_USDC);
			expect(getAddress(burn.tokenMessenger)).toBe(STAGING_TOKEN_MESSENGER);
			expect(burn.sourceDomain).toBe(0);
			// mintRecipient + destinationCaller are the router, left-padded to bytes32.
			const routerBytes32 = `0x${"00".repeat(12)}${ROUTER.slice(2).toLowerCase()}`;
			expect(burn.mintRecipient.toLowerCase()).toBe(routerBytes32);
			expect(burn.destinationCaller.toLowerCase()).toBe(routerBytes32);
			// hookData binds the TREASURY address + its eERC public key.
			const [hookUser, pkX, pkY] = decodeAbiParameters(
				[{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
				burn.hookData as Hex,
			);
			expect(getAddress(hookUser)).toBe(treasuryAddress);
			expect(pkX).toBe(eercAccount.publicKey[0]);
			expect(pkY).toBe(eercAccount.publicKey[1]);

			// EURC on Arbitrum/Optimism is unsupported (USDC-only chains).
			for (const chain of ["arbitrum", "optimism"] as const) {
				const bad = await app.inject({
					headers: { cookie: owner.cookie },
					method: "POST",
					url: `/orgs/${orgId}/treasury/fund-intent`,
					payload: { sourceChain: chain, token: "eurc", amount: "1000000" },
				});
				expect(bad.statusCode).toBe(400);
				expect(bad.json().error).toBe("unsupported_source_token");
			}

			// An unknown chain is rejected by the request schema.
			const unknownChain = await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: { sourceChain: "solana", token: "usdc", amount: "1000000" },
			});
			expect(unknownChain.statusCode).toBe(400);

			// fund-intent is admin+; a viewer is forbidden.
			const viewer = await session(db, config, `0x${"a2".repeat(20)}`);
			await db.insert(orgMembers).values({
				orgId,
				role: "viewer",
				userId: viewer.userId,
			});
			const viewerFund = await app.inject({
				headers: { cookie: viewer.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: { sourceChain: "ethereum", token: "usdc", amount: "1000000" },
			});
			expect(viewerFund.statusCode).toBe(403);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("creates a pending cctp transfer bound to the org and is idempotent per burn", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, db, logger: false, startBoss: false });
		try {
			const owner = await session(db, config, `0x${"b1".repeat(20)}`);
			const orgId = await createOrg(app, owner.cookie);
			await provisionTreasury(
				db,
				config,
				orgId,
				owner.userId,
				createManagedEercAccount(555n),
			);
			const sourceTxHash = `0x${"cd".repeat(32)}`;

			const created = await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: {
					sourceChain: "base",
					token: "usdc",
					amount: "2500000",
					sourceTxHash,
				},
			});
			expect(created.statusCode).toBe(201);
			expect(created.json().fundIntent).toMatchObject({
				orgId,
				status: "initiated",
				destToken: "usdc",
				sourceDomain: 6,
			});
			expect(created.json().burn.sourceChain).toBe("base");

			const [row] = await db
				.select()
				.from(onrampIntents)
				.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
				.limit(1);
			expect(row).toMatchObject({
				amount: "2500000",
				destToken: "usdc",
				orgId,
				sourceDomain: 6,
				status: "initiated",
			});

			// Same burn resubmitted → idempotent 200 with the same intent.
			const resubmit = await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: {
					sourceChain: "base",
					token: "usdc",
					amount: "2500000",
					sourceTxHash,
				},
			});
			expect(resubmit.statusCode).toBe(200);
			expect(resubmit.json().fundIntent.id).toBe(created.json().fundIntent.id);

			// A different org claiming the same burn is a conflict, never a rebind.
			const owner2 = await session(db, config, `0x${"b2".repeat(20)}`);
			const orgId2 = await createOrg(app, owner2.cookie);
			await provisionTreasury(
				db,
				config,
				orgId2,
				owner2.userId,
				createManagedEercAccount(777n),
			);
			const conflict = await app.inject({
				headers: { cookie: owner2.cookie },
				method: "POST",
				url: `/orgs/${orgId2}/treasury/fund-intent`,
				payload: {
					sourceChain: "base",
					token: "usdc",
					amount: "2500000",
					sourceTxHash,
				},
			});
			expect(conflict.statusCode).toBe(409);
			expect(conflict.json().error).toBe("source_tx_hash_conflict");
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("serves a unified deposits view merging direct + cctp with RBAC", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, db, logger: false, startBoss: false });
		try {
			const owner = await session(db, config, `0x${"c1".repeat(20)}`);
			const orgId = await createOrg(app, owner.cookie);
			await provisionTreasury(
				db,
				config,
				orgId,
				owner.userId,
				createManagedEercAccount(999n),
			);

			// Direct deposits (confirmed + failed) straight into the ledger.
			await db.insert(treasuryDeposits).values([
				{
					amount: "5000000",
					orgId,
					source: "direct",
					status: "confirmed",
					token: "usdc",
					tokenId: 1n,
					txHash: `0x${"01".repeat(32)}`,
				},
				{
					amount: "300000",
					orgId,
					source: "direct",
					status: "failed",
					token: "eurc",
					tokenId: 2n,
					txHash: null,
				},
			]);

			// A pending cross-chain transfer (initiated).
			await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: {
					sourceChain: "ethereum",
					token: "usdc",
					amount: "1200000",
					sourceTxHash: `0x${"ee".repeat(32)}`,
				},
			});

			const deposits = await app.inject({
				headers: { cookie: owner.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits`,
			});
			expect(deposits.statusCode).toBe(200);
			const list = deposits.json().deposits as Array<{
				kind: string;
				status: string;
				token: string;
				amount: string;
				sourceChain: string | null;
			}>;
			expect(list).toHaveLength(3);

			const direct = list.filter((d) => d.kind === "direct");
			expect(direct).toHaveLength(2);
			expect(
				direct.find((d) => d.amount === "5000000")?.status,
			).toBe("credited");
			expect(direct.find((d) => d.amount === "300000")?.status).toBe("failed");

			const cctp = list.filter((d) => d.kind === "cctp");
			expect(cctp).toHaveLength(1);
			expect(cctp[0]).toMatchObject({
				amount: "1200000",
				sourceChain: "ethereum",
				status: "pending",
				token: "usdc",
			});

			// A non-member cannot read the deposits (existence not leaked → 404).
			const outsider = await session(db, config, `0x${"c2".repeat(20)}`);
			const forbidden = await app.inject({
				headers: { cookie: outsider.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits`,
			});
			expect(forbidden.statusCode).toBe(404);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("finalizes a credited cctp funding into a treasury deposit shown as credited", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, db, logger: false, startBoss: false });
		try {
			const owner = await session(db, config, `0x${"d1".repeat(20)}`);
			const orgId = await createOrg(app, owner.cookie);
			const eercAccount = createManagedEercAccount(24_680n);
			const treasuryAddress = await provisionTreasury(
				db,
				config,
				orgId,
				owner.userId,
				eercAccount,
			);
			const pubKey: [bigint, bigint] = [
				eercAccount.publicKey[0],
				eercAccount.publicKey[1],
			];
			const sourceTxHash = `0x${"fa".repeat(32)}`;

			// Register the burn, then advance it to `attested` so the poll settles it
			// in one pass (relayer + iris stubbed).
			await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: {
					sourceChain: "ethereum",
					token: "usdc",
					amount: "3000000",
					sourceTxHash,
				},
			});
			await db
				.update(onrampIntents)
				.set({ status: "attested" })
				.where(eq(onrampIntents.sourceTxHash, sourceTxHash));

			const message = buildCctpMessage({
				amount: 3_000_000n,
				hookData: encodeOnrampHookData({
					pkX: pubKey[0],
					pkY: pubKey[1],
					user: treasuryAddress,
				}),
				nonce: 7n,
				sourceDomain: 0,
			});
			const settlements: Parameters<OnrampRelayer["settleDeposit"]>[0][] = [];
			const result = await pollOnrampIntents(db, {
				chain: chainFor(treasuryAddress, pubKey),
				config,
				iris: irisFor(sourceTxHash, message),
				limit: 200,
				relayer: {
					relayerAddress: RELAYER_ADDRESS,
					async settleDeposit(input) {
						settlements.push(input);
						return { alreadySettled: false, txHash: `0x${"12".repeat(32)}` };
					},
				},
			});

			expect(result.credited).toBe(1);
			expect(settlements).toHaveLength(1);

			const [intent] = await db
				.select()
				.from(onrampIntents)
				.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
				.limit(1);
			expect(intent).toMatchObject({ orgId, status: "credited" });

			// The relayer mirrored the credit into the treasury_deposits ledger.
			const [deposit] = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId))
				.limit(1);
			expect(deposit).toMatchObject({
				amount: "3000000",
				source: "cctp",
				status: "confirmed",
				token: "usdc",
				tokenId: 1n,
				txHash: `0x${"12".repeat(32)}`,
			});

			// The unified view shows the funding as a credited cctp deposit.
			const deposits = await app.inject({
				headers: { cookie: owner.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits`,
			});
			const cctp = (deposits.json().deposits as Array<{ kind: string }>).filter(
				(d) => d.kind === "cctp",
			);
			expect(cctp).toHaveLength(1);
			expect(cctp[0]).toMatchObject({
				amount: "3000000",
				sourceChain: "ethereum",
				status: "credited",
				token: "usdc",
			});
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("keeps a cctp funding retryable (not credited) when the ledger mirror insert fails", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, db, logger: false, startBoss: false });
		try {
			const owner = await session(db, config, `0x${"e1".repeat(20)}`);
			const orgId = await createOrg(app, owner.cookie);
			const eercAccount = createManagedEercAccount(13_579n);
			const treasuryAddress = await provisionTreasury(
				db,
				config,
				orgId,
				owner.userId,
				eercAccount,
			);
			const pubKey: [bigint, bigint] = [
				eercAccount.publicKey[0],
				eercAccount.publicKey[1],
			];
			const sourceTxHash = `0x${"eb".repeat(32)}`;

			await app.inject({
				headers: { cookie: owner.cookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/fund-intent`,
				payload: {
					sourceChain: "ethereum",
					token: "usdc",
					amount: "3000000",
					sourceTxHash,
				},
			});
			await db
				.update(onrampIntents)
				.set({ status: "attested" })
				.where(eq(onrampIntents.sourceTxHash, sourceTxHash));

			const message = buildCctpMessage({
				amount: 3_000_000n,
				hookData: encodeOnrampHookData({
					pkX: pubKey[0],
					pkY: pubKey[1],
					user: treasuryAddress,
				}),
				nonce: 11n,
				sourceDomain: 0,
			});
			const settlements: Parameters<OnrampRelayer["settleDeposit"]>[0][] = [];
			const poll = () =>
				pollOnrampIntents(db, {
					chain: chainFor(treasuryAddress, pubKey),
					config,
					iris: irisFor(sourceTxHash, message),
					limit: 200,
					relayer: {
						relayerAddress: RELAYER_ADDRESS,
						async settleDeposit(input) {
							settlements.push(input);
							return { alreadySettled: false, txHash: `0x${"12".repeat(32)}` };
						},
					},
				});

			// Force ONLY the treasury_deposits mirror insert to fail (NOT VALID so the
			// existing rows from earlier tests are untouched), simulating a transient
			// ledger-write error after the intent would otherwise be credited.
			await db.execute(
				sql`ALTER TABLE treasury_deposits ADD CONSTRAINT test_reject_cctp_mirror CHECK (source <> 'cctp') NOT VALID`,
			);

			// The failing mirror rolls the whole credit back rather than half-committing.
			await expect(poll()).rejects.toThrow();

			// Intent is NOT terminally credited — it rolled back to a non-terminal,
			// retryable status, and no orphan ledger row was written.
			const [afterFail] = await db
				.select()
				.from(onrampIntents)
				.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
				.limit(1);
			expect(afterFail?.status).toBe("attested");
			expect(afterFail?.status).not.toBe("credited");
			const orphanRows = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId));
			expect(orphanRows).toHaveLength(0);

			// Recover: once the ledger write works again, the retry credits atomically
			// and writes exactly one mirror row (idempotency key prevents a double).
			await db.execute(
				sql`ALTER TABLE treasury_deposits DROP CONSTRAINT test_reject_cctp_mirror`,
			);
			const result = await poll();
			expect(result.credited).toBe(1);

			const [afterRetry] = await db
				.select()
				.from(onrampIntents)
				.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
				.limit(1);
			expect(afterRetry?.status).toBe("credited");
			const mirrorRows = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId));
			expect(mirrorRows).toHaveLength(1);
			expect(mirrorRows[0]).toMatchObject({
				amount: "3000000",
				source: "cctp",
				status: "confirmed",
				token: "usdc",
			});
		} finally {
			await db.execute(
				sql`ALTER TABLE treasury_deposits DROP CONSTRAINT IF EXISTS test_reject_cctp_mirror`,
			);
			await app.close();
			await pool.end();
		}
	});

	it("bounds the unified deposits view by limit and pages with the before cursor", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, db, logger: false, startBoss: false });
		try {
			const owner = await session(db, config, `0x${"e2".repeat(20)}`);
			const orgId = await createOrg(app, owner.cookie);

			// Six deposits with distinct, strictly increasing createdAt so ordering is
			// deterministic: three direct rows interleaved with three cctp intents,
			// exercising the bound + cursor on BOTH source queries. amount encodes the
			// chronological index (0 = oldest, 5 = newest).
			const base = Date.now() - 60_000;
			const at = (i: number) => new Date(base + i * 1000);
			await db.insert(treasuryDeposits).values([
				{
					amount: "0",
					createdAt: at(0),
					orgId,
					source: "direct",
					status: "confirmed",
					token: "usdc",
					tokenId: 1n,
					txHash: `0x${"a0".repeat(32)}`,
				},
				{
					amount: "2",
					createdAt: at(2),
					orgId,
					source: "direct",
					status: "confirmed",
					token: "usdc",
					tokenId: 1n,
					txHash: `0x${"a2".repeat(32)}`,
				},
				{
					amount: "4",
					createdAt: at(4),
					orgId,
					source: "direct",
					status: "confirmed",
					token: "usdc",
					tokenId: 1n,
					txHash: `0x${"a4".repeat(32)}`,
				},
			]);
			await db.insert(onrampIntents).values(
				[1, 3, 5].map((i) => ({
					amount: String(i),
					createdAt: at(i),
					destToken: "usdc" as const,
					orgId,
					sourceChainId: 1,
					sourceDomain: 0,
					sourceTxHash: `0x${i.toString(16).padStart(2, "0").repeat(32)}`,
					status: "credited" as const,
					updatedAt: at(i),
					userAddress: `0x${"e2".repeat(20)}`,
					userId: owner.userId,
					userPubKeyX: "1",
					userPubKeyY: "2",
				})),
			);

			// Page 1: the two newest across BOTH sources, and a cursor for the next page.
			const page1 = await app.inject({
				headers: { cookie: owner.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits?limit=2`,
			});
			expect(page1.statusCode).toBe(200);
			const body1 = page1.json() as {
				deposits: Array<{ amount: string }>;
				nextCursor: string | null;
			};
			expect(body1.deposits).toHaveLength(2);
			expect(body1.deposits.map((d) => d.amount)).toEqual(["5", "4"]);
			expect(body1.nextCursor).toBeTruthy();

			// Page 2: strictly older than the cursor, next two newest.
			const page2 = await app.inject({
				headers: { cookie: owner.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits?limit=2&before=${encodeURIComponent(
					body1.nextCursor as string,
				)}`,
			});
			const body2 = page2.json() as {
				deposits: Array<{ amount: string }>;
				nextCursor: string | null;
			};
			expect(body2.deposits.map((d) => d.amount)).toEqual(["3", "2"]);
			expect(body2.nextCursor).toBeTruthy();

			// Page 3: the final two, no further pages.
			const page3 = await app.inject({
				headers: { cookie: owner.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits?limit=2&before=${encodeURIComponent(
					body2.nextCursor as string,
				)}`,
			});
			const body3 = page3.json() as {
				deposits: Array<{ amount: string }>;
				nextCursor: string | null;
			};
			expect(body3.deposits.map((d) => d.amount)).toEqual(["1", "0"]);
			expect(body3.nextCursor).toBeNull();

			// A bad limit is rejected rather than silently unbounded.
			const bad = await app.inject({
				headers: { cookie: owner.cookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury/deposits?limit=0`,
			});
			expect(bad.statusCode).toBe(400);
		} finally {
			await app.close();
			await pool.end();
		}
	});
});
