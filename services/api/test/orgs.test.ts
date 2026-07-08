import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { sealString, unsealString } from "../src/crypto/seal.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import {
	eventLinks,
	handles,
	orgMembers,
	orgs,
	orgTreasuries,
	payrollItems,
	payrollRuns,
	sessions,
	treasuryDeposits,
	users,
} from "../src/db/schema.js";
import { createBoss, ensureQueues } from "../src/jobs/index.js";
import type { OnboardingChainClient } from "../src/onboarding/chain.js";
import type {
	PayrollSubmitter,
	TreasuryRegistrar,
} from "../src/payroll/chain.js";
import {
	createManagedEercAccount,
	deserializeManagedEercAccount,
	encryptAmountPct,
	type EercBalance,
	serializeManagedEercAccount,
	type ManagedEercAccount,
	type TransferProofCalldata,
} from "../src/payroll/eerc.js";
import type { PayrollProver } from "../src/payroll/prover.js";
import {
	handlePayrollItemJob,
	type PayrollItemJobData,
} from "../src/payroll/runner.js";

const testMasterKey =
	"0000000000000000000000000000000000000000000000000000000000000000";
const testFundingTokens = [
	{
		address: "0x5425890298aed601595a70ab815c96711a31bc65",
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
] satisfies ApiConfig["treasuryFundingTokens"];

function baseConfig(databaseUrl: string): ApiConfig {
	return {
		appMasterKey: testMasterKey,
		apiDomain: "localhost",
		benzonetChainId: 43_113,
		benzonetRpcUrl: "http://127.0.0.1:1",
		chainEnv: "fuji",
		autoDepositRouterAddress: null,
		cctpAttestationApiBase: "https://iris-api-sandbox.circle.com",
		cctpDestDomain: 1,
		cctpDomain: null,
		cctpMessageTransmitter: null,
		cctpTokenMessenger: null,
		tier: "staging",
		corsOrigins: [...DEFAULT_CORS_ORIGINS],
		databaseUrl,
		dripBalanceThresholdWei: 500_000_000_000_000_000n,
		dripWei: 500_000_000_000_000_000n,
		eercDeploymentManifest: undefined,
		eercConverterAddress: "0x46688f1704a69a6c276cccb823e36c80787b0fa2",
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
		treasuryFundingTokens: testFundingTokens,
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

function createOnboardingChainStub(): OnboardingChainClient {
	return {
		chainEnv: "fuji",
		chainId: 43_113,
		async dripGas() {
			return {
				mode: "fuji_plain_transfer",
				result: "sent",
				txHash: `0x${"01".repeat(32)}` as `0x${string}`,
			};
		},
		async ensureAllowlisted() {
			return {
				result: "noop_fuji_no_tx_allowlist",
				txHash: null,
			};
		},
		async getNativeBalance() {
			return 0n;
		},
		async isUserRegistered() {
			return true;
		},
	};
}

function createTreasuryRegistrarStub(
	eercAccount = createManagedEercAccount(123_456n),
	onRegister?: (
		input: Parameters<TreasuryRegistrar["registerTreasury"]>[0] & {
			eercAccount: ManagedEercAccount;
		},
	) => void,
): TreasuryRegistrar {
	return {
		async registerTreasury(input) {
			const account = input.eercAccount ?? eercAccount;
			onRegister?.({ ...input, eercAccount: account });
			return {
				alreadyRegistered: false,
				eercAccount: account,
				txHash: `0x${"02".repeat(32)}` as `0x${string}`,
			};
		},
	};
}

function dummyTransferProof(): TransferProofCalldata {
	return {
		proofPoints: {
			a: [1n, 2n],
			b: [
				[3n, 4n],
				[5n, 6n],
			],
			c: [7n, 8n],
		},
		publicSignals: Array.from({ length: 32 }, (_, i) =>
			BigInt(i + 1),
		) as bigint[] & { length: 32 },
	};
}

const wait = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function insertPayrollWorkerFixture(db: Database, config: ApiConfig) {
	const eoaPrivateKey = generatePrivateKey();
	const treasuryAccount = privateKeyToAccount(eoaPrivateKey);
	const eercAccount = createManagedEercAccount(987_654n);
	const [owner] = await db
		.insert(users)
		.values({
			address: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`,
			roles: [],
		})
		.returning({ id: users.id });
	const [org] = await db
		.insert(orgs)
		.values({ name: "Worker Co", slug: `worker-${randomUUID()}` })
		.returning({ id: orgs.id });
	await db.insert(orgMembers).values({
		orgId: org!.id,
		role: "owner",
		userId: owner!.id,
	});
	await db.insert(orgTreasuries).values({
		address: treasuryAccount.address.toLowerCase(),
		consentedAt: new Date(),
		consentedBy: owner!.id,
		orgId: org!.id,
		sealedEercKey: sealString(
			config.appMasterKey,
			serializeManagedEercAccount(eercAccount),
		),
		sealedEoaKey: sealString(config.appMasterKey, eoaPrivateKey),
	});
	const [run] = await db
		.insert(payrollRuns)
		.values({
			createdBy: owner!.id,
			itemCount: 1,
			orgId: org!.id,
			status: "running",
			totalAmount: "1",
		})
		.returning({ id: payrollRuns.id });
	const [item] = await db
		.insert(payrollItems)
		.values({
			amount: "1",
			recipientInput: `0x${"51".repeat(20)}`,
			resolvedAddress: `0x${"52".repeat(20)}`,
			rowIndex: 0,
			runId: run!.id,
			status: "pending",
		})
		.returning({ id: payrollItems.id, rowIndex: payrollItems.rowIndex });
	const job = {
		data: {
			itemId: item!.id,
			orgId: org!.id,
			rowIndex: item!.rowIndex,
			runId: run!.id,
			singletonKey: `${run!.id}:${item!.rowIndex}`,
		} satisfies PayrollItemJobData,
	} as Parameters<typeof handlePayrollItemJob>[2];

	return { eoaPrivateKey, eercAccount, item: item!, job, org: org!, run: run! };
}

function createPayrollProverStub(): PayrollProver {
	return {
		async proveRegistration() {
			throw new Error("registration_not_expected");
		},
		async proveTransfer() {
			return dummyTransferProof();
		},
	};
}

function createTransferContextStub(): Pick<
	PayrollSubmitter,
	"loadTransferContext"
> {
	const receiver = createManagedEercAccount(111_111n);
	const auditor = createManagedEercAccount(222_222n);
	return {
		async loadTransferContext() {
			return {
				auditorPublicKey: auditor.publicKey,
				receiverPublicKey: receiver.publicKey,
				senderBalance: 10_000_000n,
				senderEncryptedBalance: [0n, 0n, 0n, 0n],
			};
		},
	};
}

function createPayrollSubmitterStub(
	overrides: Partial<PayrollSubmitter> = {},
): PayrollSubmitter {
	return {
		async loadTreasuryBalance() {
			throw new Error("treasury_balance_not_expected");
		},
		async loadTransferContext() {
			throw new Error("transfer_context_not_expected");
		},
		async prepareTransfer() {
			throw new Error("prepare_transfer_not_expected");
		},
		async submitPreparedTransfer() {
			throw new Error("submit_transfer_not_expected");
		},
		async submitTreasuryDeposit() {
			throw new Error("treasury_deposit_not_expected");
		},
		async waitForConfirmations() {
			throw new Error("confirmations_not_expected");
		},
		...overrides,
	};
}

function encryptedBalanceFor(
	account: ManagedEercAccount,
	amount: bigint,
): EercBalance {
	const identity = mulPointEscalar(Base8, 0n).map((value) =>
		BigInt(value),
	) as [bigint, bigint];
	const amountPoint = mulPointEscalar(Base8, amount).map((value) =>
		BigInt(value),
	) as [bigint, bigint];

	return {
		amountPCTs: [],
		balancePCT: encryptAmountPct(amount, account.publicKey),
		eGCT: {
			c1: identity,
			c2: amountPoint,
		},
	};
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
		let registeredEercAccount: ManagedEercAccount | undefined;
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async loadTreasuryBalance() {
					if (!registeredEercAccount) {
						throw new Error("registered_eerc_account_missing");
					}

					return encryptedBalanceFor(registeredEercAccount, 0n);
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(undefined, (input) => {
				registeredEercAccount = input.eercAccount;
			}),
		});
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

			// With consent → 201, returns address, custody managed, registered.
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
				registered: true,
				registrationTxHash: `0x${"02".repeat(32)}`,
			});

			// The sealed EOA/eERC keys must not be plaintext, and must unseal
			// (only with the master key) back to their managed key material.
			const [row] = await db
				.select({
					sealedEercKey: orgTreasuries.sealedEercKey,
					sealedEoaKey: orgTreasuries.sealedEoaKey,
				})
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
			expect(row!.sealedEercKey).toBeTruthy();
			expect(registeredEercAccount).toBeDefined();
			expect(row!.sealedEercKey!.toString("utf8")).not.toContain(
				registeredEercAccount!.privateKey.toString(),
			);
			const recoveredEercKey = deserializeManagedEercAccount(
				unsealString(config.appMasterKey, row!.sealedEercKey!),
			);
			expect(recoveredEercKey.privateKey).toBe(
				registeredEercAccount!.privateKey,
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
				balances: [
					{
						amount: "0",
						decimals: 6,
						symbol: "USDC",
						token: "usdc",
						tokenId: "1",
					},
					{
						amount: "0",
						decimals: 6,
						symbol: "EURC",
						token: "eurc",
						tokenId: "2",
					},
				],
				custody: "managed",
				consented: true,
				custodyConsent: {
					consented: true,
					consentedBy: expect.any(String),
				},
				registered: true,
			});
			expect(JSON.stringify(status.json())).not.toContain(recoveredKey);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("deposits treasury funding as admin and returns decrypted token balances to members", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const approvalTxHash = `0x${"03".repeat(32)}` as Hex;
		const txHash = `0x${"04".repeat(32)}` as Hex;
		// The route generates + seals its own managed eERC account during
		// provisioning; capture it so the balance stub encrypts under the same
		// key the GET handler decrypts with.
		let registeredEercAccount: ManagedEercAccount | undefined;
		let depositInput:
			| Parameters<PayrollSubmitter["submitTreasuryDeposit"]>[0]
			| undefined;
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async loadTreasuryBalance(input) {
					if (!registeredEercAccount) {
						throw new Error("registered_eerc_account_missing");
					}
					return encryptedBalanceFor(
						registeredEercAccount,
						input.tokenId === 1n ? 7_650_000n : 0n,
					);
				},
				async submitTreasuryDeposit(input) {
					depositInput = input;
					return { approvalTxHash, txHash };
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(undefined, (input) => {
				registeredEercAccount = input.eercAccount;
			}),
		});
		const owner = `0x${"a7".repeat(20)}`;
		const operator = `0x${"b8".repeat(20)}`;
		const outsider = `0x${"c9".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const operatorCookie = await session(db, config, operator);
			const outsiderCookie = await session(db, config, outsider);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Treasury Co", slug: `treasury-${randomUUID()}` },
			});
			const orgId = created.json().org.id as string;
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/members`,
				payload: { address: operator, role: "operator" },
			});
			const provisioned = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});
			expect(provisioned.statusCode).toBe(201);

			const operatorDeposit = await app.inject({
				headers: { cookie: operatorCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: {
					amount: "2500000",
					idempotencyKey: randomUUID(),
					token: "usdc",
				},
			});
			expect(operatorDeposit.statusCode).toBe(403);

			const invalidDeposit = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: { amount: "0", idempotencyKey: randomUUID(), token: "usdc" },
			});
			expect(invalidDeposit.statusCode).toBe(400);

			// A money-movement deposit must be safe to retry, so the idempotency key
			// is mandatory: a request omitting it is rejected before any broadcast.
			const missingKeyDeposit = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: { amount: "2500000", token: "usdc" },
			});
			expect(missingKeyDeposit.statusCode).toBe(400);

			const deposited = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: {
					amount: "2500000",
					idempotencyKey: randomUUID(),
					token: "usdc",
				},
			});
			expect(deposited.statusCode).toBe(201);
			expect(deposited.json()).toMatchObject({
				amount: "2500000",
				approvalTxHash,
				source: "direct",
				status: "confirmed",
				token: "usdc",
				tokenId: "1",
				txHash,
			});
			expect(depositInput).toMatchObject({
				amount: 2_500_000n,
				tokenAddress: testFundingTokens[0].address,
			});
			expect(depositInput?.amountPCT).toHaveLength(7);
			expect(depositInput?.eoaPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
			// Confirmations are threaded from config.indexerConfirmations (6), not
			// the unsafe 1-confirmation default.
			expect(depositInput?.confirmations).toBe(config.indexerConfirmations);

			const [row] = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId))
				.limit(1);
			expect(row).toMatchObject({
				amount: "2500000",
				source: "direct",
				status: "confirmed",
				token: "usdc",
				tokenId: 1n,
				txHash: txHash.toLowerCase(),
			});

			const balance = await app.inject({
				headers: { cookie: ownerCookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury`,
			});
			expect(balance.statusCode).toBe(200);
			expect(balance.json()).toMatchObject({
				balances: [
					{ amount: "7650000", token: "usdc", tokenId: "1" },
					{ amount: "0", token: "eurc", tokenId: "2" },
				],
				registered: true,
			});

			const outsiderBalance = await app.inject({
				headers: { cookie: outsiderCookie },
				method: "GET",
				url: `/orgs/${orgId}/treasury`,
			});
			expect(outsiderBalance.statusCode).toBe(404);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("pre-inserts a submitted deposit before broadcasting, then confirms it", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const approvalTxHash = `0x${"05".repeat(32)}` as Hex;
		const txHash = `0x${"06".repeat(32)}` as Hex;
		let depositOrgId: string | undefined;
		let statusAtBroadcast: string | undefined;
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async submitTreasuryDeposit() {
					// At broadcast time the durable row must already exist as
					// `submitted`, so a crash here cannot lose the ledger entry.
					const [pending] = await db
						.select()
						.from(treasuryDeposits)
						.where(eq(treasuryDeposits.orgId, depositOrgId!))
						.limit(1);
					statusAtBroadcast = pending?.status;
					return { approvalTxHash, txHash };
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(),
		});
		const owner = `0x${"d1".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Durable Co", slug: `durable-${randomUUID()}` },
			});
			const orgId = created.json().org.id as string;
			depositOrgId = orgId;
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});

			const deposited = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: {
					amount: "1000000",
					idempotencyKey: randomUUID(),
					token: "usdc",
				},
			});
			expect(deposited.statusCode).toBe(201);
			// The row existed as `submitted` while the tx was broadcasting...
			expect(statusAtBroadcast).toBe("submitted");

			// ...and flipped to `confirmed` (with the tx hash) once it settled.
			const [row] = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId))
				.limit(1);
			expect(row).toMatchObject({
				status: "confirmed",
				txHash: txHash.toLowerCase(),
			});
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("resumes a keyed deposit whose first attempt crashed before broadcasting", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const approvalTxHash = `0x${"07".repeat(32)}` as Hex;
		const txHash = `0x${"08".repeat(32)}` as Hex;
		let submitCalls = 0;
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async submitTreasuryDeposit() {
					submitCalls += 1;
					return { approvalTxHash, txHash };
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(),
		});
		const owner = `0x${"d2".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Resume Co", slug: `resume-${randomUUID()}` },
			});
			const orgId = created.json().org.id as string;
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});

			// Simulate a first attempt that inserted the `submitted` row but crashed
			// BEFORE broadcasting (no txHash), long enough ago to be past the lease.
			const key = randomUUID();
			await db.insert(treasuryDeposits).values({
				amount: "1000000",
				idempotencyKey: key,
				orgId,
				source: "direct",
				status: "submitted",
				token: "usdc",
				tokenId: 1n,
				txHash: null,
				updatedAt: new Date(Date.now() - 5 * 60_000),
			});

			// A retry with the same key must RESUME (re-broadcast), not return a
			// terminal stuck `submitted`/txHash:null.
			const resumed = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: { amount: "1000000", idempotencyKey: key, token: "usdc" },
			});
			expect(resumed.statusCode).toBe(201);
			expect(submitCalls).toBe(1);

			// Still ONE row for the key (resumed in place), now confirmed with a hash.
			const rows = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				status: "confirmed",
				txHash: txHash.toLowerCase(),
			});
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("marks the deposit failed and returns 502 when submission throws", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async submitTreasuryDeposit() {
					throw new Error("treasury_deposit_reverted");
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(),
		});
		const owner = `0x${"d2".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Failure Co", slug: `failure-${randomUUID()}` },
			});
			const orgId = created.json().org.id as string;
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});

			const deposited = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: {
					amount: "1000000",
					idempotencyKey: randomUUID(),
					token: "usdc",
				},
			});
			expect(deposited.statusCode).toBe(502);
			expect(deposited.json()).toMatchObject({
				error: "treasury_deposit_failed",
			});

			// The durable row is retained as `failed` with no tx hash for
			// observability; nothing sensitive is persisted.
			const [row] = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId))
				.limit(1);
			expect(row).toMatchObject({ status: "failed", txHash: null });
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("keeps the deposit submitted with its hash and returns 202 when only the confirmation wait fails", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const txHash = `0x${"0a".repeat(32)}` as Hex;
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async submitTreasuryDeposit(input) {
					// The tx was broadcast (hash surfaced via onBeforeBroadcast) but the
					// confirmation wait fails — the tx may still land on-chain.
					await input.onBeforeBroadcast?.(txHash);
					throw new Error("treasury_deposit_confirmation_timeout");
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(),
		});
		const owner = `0x${"d4".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: {
					name: "Unconfirmed Co",
					slug: `unconfirmed-${randomUUID()}`,
				},
			});
			const orgId = created.json().org.id as string;
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});

			const deposited = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: {
					amount: "1000000",
					idempotencyKey: randomUUID(),
					token: "usdc",
				},
			});
			// Broadcast-but-unconfirmed: 202, not 502, and the hash is returned.
			expect(deposited.statusCode).toBe(202);
			expect(deposited.json()).toMatchObject({
				amount: "1000000",
				source: "direct",
				status: "submitted",
				token: "usdc",
				tokenId: "1",
				txHash,
			});

			// The row is left `submitted` with the persisted hash for later
			// reconciliation — never `failed`, so no moved money is lost.
			const [row] = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId))
				.limit(1);
			expect(row).toMatchObject({
				status: "submitted",
				txHash: txHash.toLowerCase(),
			});
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("deduplicates a repeated idempotencyKey without a second submission", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const approvalTxHash = `0x${"07".repeat(32)}` as Hex;
		const txHash = `0x${"08".repeat(32)}` as Hex;
		let submitCount = 0;
		const app = await buildApp({
			config,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			payrollSubmitter: createPayrollSubmitterStub({
				async submitTreasuryDeposit() {
					submitCount += 1;
					return { approvalTxHash, txHash };
				},
			}),
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(),
		});
		const owner = `0x${"d3".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Idem Co", slug: `idem-${randomUUID()}` },
			});
			const orgId = created.json().org.id as string;
			await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});

			const key = randomUUID();
			const first = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: { amount: "1000000", idempotencyKey: key, token: "usdc" },
			});
			expect(first.statusCode).toBe(201);

			const retry = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury/deposit`,
				payload: { amount: "1000000", idempotencyKey: key, token: "usdc" },
			});
			// The retry returns the original record (200) and never re-submits.
			expect(retry.statusCode).toBe(200);
			expect(retry.json()).toMatchObject({
				amount: "1000000",
				status: "confirmed",
				token: "usdc",
				tokenId: "1",
				txHash: txHash.toLowerCase(),
			});
			expect(submitCount).toBe(1);

			// Exactly one durable row exists for the org.
			const rows = await db
				.select()
				.from(treasuryDeposits)
				.where(eq(treasuryDeposits.orgId, orgId));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.idempotencyKey).toBe(key);
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

			// Leading blank lines (common from export tools) must not hide the header.
			const csv = `\n\n${[
				"recipient,amount", // header — skipped
				`@alice,100.50`, // valid → alice
				`${rawAddr},25`, // valid → raw address
				`@nobody,10`, // unknown handle
				`@alice,5`, // duplicate of alice
				`0x${"ca".repeat(20)},abc`, // invalid amount
			].join("\n")}`;

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
			expect(byRow[1]).toMatchObject({
				status: "pending",
				resolvedAddress: rawAddr,
			});
			expect(byRow[2]).toMatchObject({
				status: "failed",
				error: "unknown_recipient",
			});
			expect(byRow[3]).toMatchObject({
				status: "failed",
				error: "duplicate_recipient",
			});
			expect(byRow[4]).toMatchObject({
				status: "failed",
				error: "invalid_amount",
			});

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
			expect(getRun.json().run).toMatchObject({
				status: "ready",
				itemCount: 2,
			});

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

	it("caps run size and chunks large item inserts past the param limit", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const app = await buildApp({ config, logger: false, startBoss: false });
		const owner = `0x${"33".repeat(20)}`;

		try {
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Scaleco", slug: "scaleco" },
			});
			const orgId = created.json().org.id as string;

			const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

			// Over the cap → 400.
			const tooMany = Array.from({ length: 10_001 }, (_, i) => `${addr(i)},1`);
			const capped = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/payroll`,
				payload: { csv: tooMany.join("\n") },
			});
			expect(capped.statusCode).toBe(400);
			expect(capped.json().error).toBe("too_many_rows");

			// 6000 rows crosses the 5000-row insert batch → two chunks, must persist all.
			const rows = Array.from({ length: 6_000 }, (_, i) => `${addr(i)},1`);
			const res = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/payroll`,
				payload: { csv: rows.join("\n") },
			});
			expect(res.statusCode).toBe(201);
			expect(res.json().summary).toMatchObject({ valid: 6_000, invalid: 0 });

			const persisted = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.runId, res.json().runId as string));
			expect(persisted).toHaveLength(6_000);
		} finally {
			await app.close();
			await pool.end();
		}
	});

	it("starts a payroll run with singleton item jobs idempotently", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const boss = createBoss(config);
		const app = await buildApp({
			boss,
			config,
			db,
			logger: false,
			onboardingChain: createOnboardingChainStub(),
			pool,
			startBoss: false,
			treasuryRegistrar: createTreasuryRegistrarStub(),
		});
		const owner = `0x${"44".repeat(20)}`;

		try {
			await boss.start();
			await ensureQueues(boss);
			const ownerCookie = await session(db, config, owner);
			const created = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: "/orgs",
				payload: { name: "Runner Co", slug: "runner-co" },
			});
			const orgId = created.json().org.id as string;
			const treasury = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/treasury`,
				payload: { consent: true },
			});
			expect(treasury.statusCode).toBe(201);
			expect(treasury.json().registered).toBe(true);

			const csv = [`0x${"55".repeat(20)},1`, `0x${"66".repeat(20)},2`].join(
				"\n",
			);
			const preview = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/orgs/${orgId}/payroll`,
				payload: { csv },
			});
			expect(preview.statusCode).toBe(201);
			const runId = preview.json().runId as string;

			const started = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/payroll/${runId}/start`,
			});
			expect(started.statusCode).toBe(202);
			expect(started.json()).toMatchObject({
				enqueued: 2,
				status: "running",
				totalPending: 2,
			});

			const duplicate = await app.inject({
				headers: { cookie: ownerCookie },
				method: "POST",
				url: `/payroll/${runId}/start`,
			});
			expect(duplicate.statusCode).toBe(202);
			expect(duplicate.json()).toMatchObject({
				enqueued: 0,
				status: "running",
				totalPending: 2,
			});
		} finally {
			await app.close();
			await boss.stop().catch(() => undefined);
			await pool.end();
		}
	});

	it("processes same-org payroll items sequentially and links receipts", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const eoaPrivateKey =
			"0x0000000000000000000000000000000000000000000000000000000000000045";
		const treasuryAccount = privateKeyToAccount(eoaPrivateKey);
		const eercAccount = createManagedEercAccount(987_654n);
		const receiver = createManagedEercAccount(111_111n);
		const auditor = createManagedEercAccount(222_222n);
		let activeProofs = 0;
		let maxActiveProofs = 0;
		let prepareCount = 0;
		let submitCount = 0;
		const submittedRows: number[] = [];
		const prover: PayrollProver = {
			async proveRegistration() {
				throw new Error("registration_not_expected");
			},
			async proveTransfer() {
				activeProofs += 1;
				maxActiveProofs = Math.max(maxActiveProofs, activeProofs);
				await wait(25);
				activeProofs -= 1;
				return dummyTransferProof();
			},
		};
		const submitter: PayrollSubmitter = {
			...createPayrollSubmitterStub(),
			async loadTransferContext() {
				return {
					auditorPublicKey: auditor.publicKey,
					receiverPublicKey: receiver.publicKey,
					senderBalance: 10_000_000n,
					senderEncryptedBalance: [0n, 0n, 0n, 0n],
				};
			},
			async prepareTransfer(input) {
				prepareCount += 1;
				submittedRows.push(Number(input.proof.publicSignals[0]));
				return {
					rawTransaction: `0x${prepareCount.toString(16).padStart(64, "0")}`,
					txHash: `0x${prepareCount.toString(16).padStart(64, "0")}`,
				};
			},
			async submitPreparedTransfer(input) {
				submitCount += 1;
				return { txHash: input.txHash };
			},
			async waitForConfirmations() {
				await wait(5);
			},
		};

		try {
			const [owner] = await db
				.insert(users)
				.values({ address: `0x${"77".repeat(20)}`, roles: [] })
				.returning({ id: users.id });
			const [org] = await db
				.insert(orgs)
				.values({ name: "Sequential Co", slug: `seq-${randomUUID()}` })
				.returning({ id: orgs.id });
			await db.insert(orgMembers).values({
				orgId: org!.id,
				role: "owner",
				userId: owner!.id,
			});
			await db.insert(orgTreasuries).values({
				address: treasuryAccount.address.toLowerCase(),
				consentedAt: new Date(),
				consentedBy: owner!.id,
				orgId: org!.id,
				sealedEercKey: sealString(
					config.appMasterKey,
					serializeManagedEercAccount(eercAccount),
				),
				sealedEoaKey: sealString(config.appMasterKey, eoaPrivateKey),
			});
			const [run] = await db
				.insert(payrollRuns)
				.values({
					createdBy: owner!.id,
					itemCount: 3,
					orgId: org!.id,
					status: "running",
					totalAmount: "6",
				})
				.returning({ id: payrollRuns.id });
			const insertedItems = await db
				.insert(payrollItems)
				.values(
					[1, 2, 3].map((i) => ({
						amount: String(i),
						recipientInput: `0x${String(i).repeat(40).slice(0, 40)}`,
						resolvedAddress: `0x${(80 + i).toString(16).repeat(20)}`,
						rowIndex: i - 1,
						runId: run!.id,
						status: "pending" as const,
					})),
				)
				.returning({
					id: payrollItems.id,
					rowIndex: payrollItems.rowIndex,
				});

			const jobFor = (item: { id: string; rowIndex: number }) =>
				({
					data: {
						itemId: item.id,
						orgId: org!.id,
						rowIndex: item.rowIndex,
						runId: run!.id,
						singletonKey: `${run!.id}:${item.rowIndex}`,
					} satisfies PayrollItemJobData,
				}) as Parameters<typeof handlePayrollItemJob>[2];

			await Promise.all(
				insertedItems.map((item) =>
					handlePayrollItemJob(
						db,
						{ config, pool, prover, submitter },
						jobFor(item),
					),
				),
			);

			expect(maxActiveProofs).toBe(1);
			expect(prepareCount).toBe(3);
			expect(submitCount).toBe(3);
			expect(submittedRows).toEqual([1, 1, 1]);

			const rows = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.runId, run!.id))
				.orderBy(payrollItems.rowIndex);
			expect(rows.map((row) => row.status)).toEqual([
				"confirmed",
				"confirmed",
				"confirmed",
			]);
			expect(rows.every((row) => row.txHash)).toBe(true);
			const [settledRun] = await db
				.select({ status: payrollRuns.status })
				.from(payrollRuns)
				.where(eq(payrollRuns.id, run!.id))
				.limit(1);
			expect(settledRun?.status).toBe("complete");

			const links = await db
				.select()
				.from(eventLinks)
				.where(eq(eventLinks.objectId, run!.id));
			expect(links).toHaveLength(3);
			expect(new Set(links.map((link) => link.objectType))).toEqual(
				new Set(["payroll_items"]),
			);

			await handlePayrollItemJob(
				db,
				{ config, pool, prover, submitter },
				jobFor(insertedItems[0]!),
			);
			expect(prepareCount).toBe(3);
			expect(submitCount).toBe(3);
		} finally {
			await pool.end();
		}
	});

	it("resumes a prepared transfer without creating a second transfer after a broadcast crash", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const fixture = await insertPayrollWorkerFixture(db, config);
		const rawTransaction = `0x${"ab".repeat(32)}` as `0x${string}`;
		const txHash = `0x${"cd".repeat(32)}` as `0x${string}`;
		let prepareCount = 0;
		let submitCalls = 0;
		const uniqueBroadcasts = new Set<string>();
		const submitter: PayrollSubmitter = {
			...createPayrollSubmitterStub(),
			...createTransferContextStub(),
			async prepareTransfer() {
				prepareCount += 1;
				return { rawTransaction, txHash };
			},
			async submitPreparedTransfer(input) {
				submitCalls += 1;
				uniqueBroadcasts.add(input.rawTransaction);
				if (submitCalls === 1) {
					throw new Error("crash_after_broadcast");
				}
				return { txHash: input.txHash };
			},
			async waitForConfirmations() {
				return undefined;
			},
		};

		try {
			await expect(
				handlePayrollItemJob(
					db,
					{ config, pool, prover: createPayrollProverStub(), submitter },
					fixture.job,
				),
			).rejects.toThrow("crash_after_broadcast");
			await handlePayrollItemJob(
				db,
				{ config, pool, prover: createPayrollProverStub(), submitter },
				fixture.job,
			);

			expect(prepareCount).toBe(1);
			expect(submitCalls).toBe(2);
			expect([...uniqueBroadcasts]).toEqual([rawTransaction]);
			const [row] = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.id, fixture.item.id))
				.limit(1);
			expect(row).toMatchObject({
				status: "confirmed",
				submissionRawTx: null,
				txHash,
			});
		} finally {
			await pool.end();
		}
	});

	it("keeps a broadcast item submitted when confirmation retries fail", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const fixture = await insertPayrollWorkerFixture(db, config);
		const txHash = `0x${"ef".repeat(32)}` as `0x${string}`;
		const submitter: PayrollSubmitter = {
			...createPayrollSubmitterStub(),
			...createTransferContextStub(),
			async prepareTransfer() {
				return {
					rawTransaction: `0x${"12".repeat(32)}`,
					txHash,
				};
			},
			async submitPreparedTransfer(input) {
				return { txHash: input.txHash };
			},
			async waitForConfirmations() {
				throw new Error("confirmation_timeout");
			},
		};

		try {
			await expect(
				handlePayrollItemJob(
					db,
					{ config, pool, prover: createPayrollProverStub(), submitter },
					fixture.job,
				),
			).rejects.toThrow("confirmation_timeout");

			const [row] = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.id, fixture.item.id))
				.limit(1);
			expect(row).toMatchObject({
				attempt: 1,
				confirmationAttempt: 1,
				error: "confirmation_timeout",
				status: "submitted",
				txHash,
			});
		} finally {
			await pool.end();
		}
	});

	it("marks a reverted transfer receipt failed instead of confirmed", async () => {
		const pool = createPool(config);
		const db = createDb(pool);
		const fixture = await insertPayrollWorkerFixture(db, config);
		const txHash = `0x${"34".repeat(32)}` as `0x${string}`;
		const submitter: PayrollSubmitter = {
			...createPayrollSubmitterStub(),
			...createTransferContextStub(),
			async prepareTransfer() {
				return {
					rawTransaction: `0x${"56".repeat(32)}`,
					txHash,
				};
			},
			async submitPreparedTransfer(input) {
				return { txHash: input.txHash };
			},
			async waitForConfirmations() {
				throw new Error("transfer_reverted");
			},
		};

		try {
			await handlePayrollItemJob(
				db,
				{ config, pool, prover: createPayrollProverStub(), submitter },
				fixture.job,
			);

			const [row] = await db
				.select()
				.from(payrollItems)
				.where(eq(payrollItems.id, fixture.item.id))
				.limit(1);
			expect(row).toMatchObject({
				error: "transfer_reverted",
				status: "failed",
				txHash,
			});
			const [run] = await db
				.select({ error: payrollRuns.error, status: payrollRuns.status })
				.from(payrollRuns)
				.where(eq(payrollRuns.id, fixture.run.id))
				.limit(1);
			expect(run).toMatchObject({
				error: "no_confirmed_items",
				status: "failed",
			});
		} finally {
			await pool.end();
		}
	});
});
