import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { encodeAbiParameters, getAddress, type Hex, recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createAuditorKeypair } from "../src/auditor/crypto.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import { sealString } from "../src/crypto/seal.js";
import { auditorKeys, events, sessions, users } from "../src/db/schema.js";
import { proofOfPaymentMessage } from "../src/disclosure/attest.js";
import { recoverDisclosedAmount } from "../src/disclosure/verify.js";
import {
	type PoseidonPCT,
	processPoseidonPCT,
} from "../src/payroll/eerc.js";

const testMasterKey =
	"0000000000000000000000000000000000000000000000000000000000000000";
const testOpsPrivateKey =
	"0x0000000000000000000000000000000000000000000000000000000000000001";
const testEncryptedErcAddress = "0x46688f1704a69a6c276cccb823e36c80787b0fa2";
const testRegistrarAddress = "0x9a63fea9851097dbaf3757b636217fdde50abaf0";
const payer = normalizeAddress("0x1111111111111111111111111111111111111111");
const payee = normalizeAddress("0x2222222222222222222222222222222222222222");
const outsider = normalizeAddress("0x3333333333333333333333333333333333333333");
const attestationPrivateKey = generatePrivateKey();
const attestationAddress = privateKeyToAccount(attestationPrivateKey).address;

describe("@benzo/api disclosure (W3)", () => {
	let postgres: StartedPostgreSqlContainer;
	let pool: ReturnType<typeof createPool>;
	let db: Database;
	let config: ApiConfig;
	let app: Awaited<ReturnType<typeof buildApp>>;

	// A real auditor PCT fixture: the sender keeps `encRandom` from proof
	// generation; the amount is encrypted to the auditor's public key.
	const auditorKey = createAuditorKeypair(4242n);
	const auditorPublicKey: [bigint, bigint] = [
		BigInt(auditorKey.publicKey[0]),
		BigInt(auditorKey.publicKey[1]),
	];
	const amount = 1_500_000n;
	const fixture = processPoseidonPCT([amount], auditorPublicKey, "fixture");
	const otherEncRandom = processPoseidonPCT(
		[amount],
		auditorPublicKey,
		"other",
	).encRandom;
	const paymentTxHash = txHash(1);
	const paymentLogIndex = 0;

	beforeAll(async () => {
		postgres = await new PostgreSqlContainer("postgres:17-alpine")
			.withDatabase("benzo_disclosure_test")
			.withUsername("benzo")
			.withPassword("benzo")
			.start();
		config = {
			appMasterKey: testMasterKey,
			apiDomain: "localhost",
			auditorAttestationPrivateKey: attestationPrivateKey,
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
			databaseUrl: postgres.getConnectionUri(),
			dripBalanceThresholdWei: 500_000_000_000_000_000n,
			dripWei: 500_000_000_000_000_000n,
			eercDeploymentManifest: undefined,
			eercConverterAddress: testEncryptedErcAddress,
			eercEncryptedErcAddress: testEncryptedErcAddress,
			eercRegistrarAddress: testRegistrarAddress,
			host: "127.0.0.1",
			indexerConfirmations: 6,
			indexerEnabled: true,
			indexerMaxWindowBlocks: 2_000,
			indexerPollCron: "*/5 * * * * *",
			indexerStartBlock: 0n,
			kycProvider: "mock",
			logLevel: "silent",
			nodeEnv: "test",
			onboardingRegistrationPollSeconds: 1,
			onrampPollCron: "*/15 * * * * *",
			onrampPollerEnabled: true,
			opsPrivateKey: testOpsPrivateKey,
			payrollEercDecimals: 6,
			payrollTokenId: 1n,
			payrollZkArtifactDir: "/tmp/benzo-disclosure-test-zk-artifacts",
			port: 0,
			relayerPrivateKey:
				"0x0000000000000000000000000000000000000000000000000000000000000002",
			sessionCookieName: "benzo_test_session",
			sessionTtlDays: 7,
			siweNonceTtlMinutes: 10,
			treasuryFundingTokens: [],
			treasuryReconcileCron: "*/30 * * * * *",
			treasuryReconcilerEnabled: true,
		};

		await migrateTestDatabase(config);
		pool = createPool(config);
		db = createDb(pool);

		await db.insert(auditorKeys).values({
			activatedBlockNumber: 0n,
			active: true,
			publicKeyX: auditorKey.publicKey[0],
			publicKeyY: auditorKey.publicKey[1],
			sealedKey: sealString(config.appMasterKey, auditorKey.privateKey),
		});
		await insertTransferEvent(db, {
			amountPct: encodePct(fixture.pct),
			blockNumber: 10n,
			from: payer,
			logIndex: paymentLogIndex,
			to: payee,
			txHash: paymentTxHash,
		});
		// A second, unrelated payment encrypted with a different encRandom. Used to
		// prove a reveal for one transfer does not decrypt another (privacy).
		await insertTransferEvent(db, {
			amountPct: encodePct(
				processPoseidonPCT([999n], auditorPublicKey, "unrelated").pct,
			),
			blockNumber: 11n,
			from: outsider,
			logIndex: 0,
			to: payee,
			txHash: txHash(2),
		});

		app = await buildApp({ config, db, logger: false, startBoss: false });
	});

	afterAll(async () => {
		await app?.close();
		await pool?.end();
		await postgres?.stop();
	});

	describe("Tier A — trustless self-disclosure", () => {
		it("confirms a correct {encRandom, amount} against the real auditorPCT", async () => {
			const response = await verify({
				claimedAmount: amount.toString(),
				encRandom: fixture.encRandom.toString(),
				from: payer,
				logIndex: paymentLogIndex,
				to: payee,
				txHash: paymentTxHash,
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				amount: amount.toString(),
				from: payer,
				to: payee,
				txHash: paymentTxHash,
				verified: true,
			});
		});

		it("rejects a wrong claimed amount", async () => {
			const response = await verify({
				claimedAmount: (amount + 1n).toString(),
				encRandom: fixture.encRandom.toString(),
				logIndex: paymentLogIndex,
				txHash: paymentTxHash,
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				reason: "amount_mismatch",
				verified: false,
			});
		});

		it("rejects an unknown transaction", async () => {
			const response = await verify({
				claimedAmount: amount.toString(),
				encRandom: fixture.encRandom.toString(),
				logIndex: paymentLogIndex,
				txHash: txHash(99),
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				reason: "event_not_found",
				verified: false,
			});
		});

		it("rejects mismatched counterparties", async () => {
			const response = await verify({
				claimedAmount: amount.toString(),
				encRandom: fixture.encRandom.toString(),
				from: outsider,
				logIndex: paymentLogIndex,
				txHash: paymentTxHash,
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				reason: "from_mismatch",
				verified: false,
			});
		});

		it("rejects a malformed `from` on a mint event instead of silently passing", async () => {
			// A mint has no sender (fromAddr null). A syntactically invalid `from`
			// normalizes to null and once matched the null column, silently passing
			// the counterparty check the caller intended to enforce.
			const mint = processPoseidonPCT([amount], auditorPublicKey, "mint");
			await insertTransferEvent(db, {
				amountPct: encodePct(mint.pct),
				blockNumber: 12n,
				from: null,
				logIndex: 0,
				to: payee,
				txHash: txHash(3),
			});

			const response = await verify({
				claimedAmount: amount.toString(),
				encRandom: mint.encRandom.toString(),
				from: "0x1234",
				logIndex: 0,
				to: payee,
				txHash: txHash(3),
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				reason: "from_mismatch",
				verified: false,
			});
		});

		it("does not decrypt an unrelated event under the same reveal (privacy)", async () => {
			const response = await verify({
				claimedAmount: "999",
				encRandom: fixture.encRandom.toString(),
				logIndex: 0,
				txHash: txHash(2),
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				reason: "auth_key_mismatch",
				verified: false,
			});
		});

		it("recoverDisclosedAmount rejects a foreign encRandom without leaking the amount", () => {
			const wrong = recoverDisclosedAmount({
				amountPct: encodePct(fixture.pct),
				auditorPublicKey,
				encRandom: otherEncRandom,
			});
			const right = recoverDisclosedAmount({
				amountPct: encodePct(fixture.pct),
				auditorPublicKey,
				encRandom: fixture.encRandom,
			});

			expect(wrong).toEqual({ ok: false, reason: "auth_key_mismatch" });
			expect(right).toEqual({ ok: true, amount });
		});
	});

	describe("Tier B — auditor-signed proof-of-payment", () => {
		it("returns a packet whose signature recovers to the attestation address", async () => {
			const cookie = await createTestSession(db, config, payer);
			const response = await app.inject({
				headers: { cookie },
				method: "POST",
				payload: { logIndex: paymentLogIndex, txHash: paymentTxHash },
				url: "/disclosure/proof-of-payment",
			});

			expect(response.statusCode).toBe(200);
			const { packet } = response.json() as {
				packet: Record<string, unknown> & { signature: Hex };
			};
			expect(packet).toMatchObject({
				amount: amount.toString(),
				attestationAddress,
				from: payer,
				to: payee,
				txHash: paymentTxHash,
			});

			const { signature, ...unsigned } = packet;
			const recovered = await recoverMessageAddress({
				message: proofOfPaymentMessage(
					unsigned as unknown as Parameters<typeof proofOfPaymentMessage>[0],
				),
				signature,
			});
			expect(getAddress(recovered)).toBe(getAddress(attestationAddress));
		});

		it("is gated to the payer/payee", async () => {
			const cookie = await createTestSession(db, config, outsider);
			const response = await app.inject({
				headers: { cookie },
				method: "POST",
				payload: { logIndex: paymentLogIndex, txHash: paymentTxHash },
				url: "/disclosure/proof-of-payment",
			});

			expect(response.statusCode).toBe(403);
		});

		it("requires authentication", async () => {
			const response = await app.inject({
				method: "POST",
				payload: { logIndex: paymentLogIndex, txHash: paymentTxHash },
				url: "/disclosure/proof-of-payment",
			});

			expect(response.statusCode).toBe(401);
		});
	});

	describe("GET /disclosure/attestation-key", () => {
		it("publishes the configured signer address", async () => {
			const response = await app.inject({
				method: "GET",
				url: "/disclosure/attestation-key",
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ attestationAddress });
		});
	});

	async function verify(payload: Record<string, unknown>) {
		return app.inject({
			method: "POST",
			payload,
			url: "/disclosure/verify",
		});
	}
});

function encodePct(pct: PoseidonPCT): Buffer {
	return Buffer.from(
		encodeAbiParameters([{ type: "uint256[7]" }], [pct]).slice(2),
		"hex",
	);
}

async function insertTransferEvent(
	db: Database,
	input: {
		amountPct: Buffer;
		blockNumber: bigint;
		from: string | null;
		logIndex: number;
		to: string;
		txHash: string;
	},
): Promise<void> {
	await db.insert(events).values({
		amountPct: input.amountPct,
		blockHash: blockHash(input.blockNumber),
		blockNumber: input.blockNumber,
		blockTime: new Date((1_700_000_000 + Number(input.blockNumber)) * 1_000),
		contract: testEncryptedErcAddress,
		eventName: "PrivateTransfer",
		fromAddr: input.from,
		logIndex: input.logIndex,
		rawLog: {},
		toAddr: input.to,
		transactionIndex: 0,
		txHash: input.txHash,
	});
}

async function createTestSession(
	db: Database,
	config: ApiConfig,
	address: string,
): Promise<string> {
	const [user] = await db
		.insert(users)
		.values({ address, roles: [] })
		.onConflictDoUpdate({ set: { roles: [] }, target: users.address })
		.returning({ id: users.id });

	if (!user) {
		throw new Error("test user insert failed");
	}

	const sessionId = randomUUID();
	await db.insert(sessions).values({
		expiresAt: new Date(Date.now() + 86_400_000),
		id: sessionId,
		userId: user.id,
	});

	return `${config.sessionCookieName}=${sessionId}`;
}

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

function txHash(id: number): `0x${string}` {
	return `0x${id.toString(16).padStart(64, "0")}`;
}

function blockHash(blockNumber: bigint): `0x${string}` {
	return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function normalizeAddress(address: string): string {
	return getAddress(address).toLowerCase();
}
