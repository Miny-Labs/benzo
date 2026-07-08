import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
	ContractFunctionRevertedError,
	decodeAbiParameters,
	encodeAbiParameters,
	encodeErrorResult,
	getAddress,
	type Hex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
	createAuditorKeypair,
	decryptAuditorAmountPct,
} from "../src/auditor/crypto.js";
import { DEFAULT_CORS_ORIGINS, type ApiConfig } from "../src/config.js";
import { createDb, createPool, type Database } from "../src/db/client.js";
import { onrampIntents, sessions, users } from "../src/db/schema.js";
import { computeOnrampAmountPCT } from "../src/onramp/amountpct.js";
import type { OnrampChainClient } from "../src/onramp/chain.js";
import type { IrisClient } from "../src/onramp/cctp.js";
import { encodeOnrampHookData } from "../src/onramp/hookdata.js";
import { pollOnrampIntents } from "../src/onramp/poller.js";
import {
	isCctpMessageReplayError,
	type OnrampRelayer,
} from "../src/onramp/relayer.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTERED = getAddress("0x1111111111111111111111111111111111111111");
const UNREGISTERED = getAddress("0x2222222222222222222222222222222222222222");
const PRECLAIMER = getAddress("0x3333333333333333333333333333333333333333");
const ROUTER = getAddress("0x00000000000000000000000000000000000000aa");
const BURN_TOKEN = getAddress("0x5425890298aed601595a70ab815c96711a31bc65");
const TOKEN_MESSENGER = getAddress("0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa");
const RELAYER_ADDRESS = getAddress("0x984E075152391C018Df97161D51C6BfE52631508");
const PK_X = 123n;
const PK_Y = 456n;
const ATTESTATION = "0x1234" as Hex;
const cctpReplayAbi = [
	{
		inputs: [{ name: "nonce", type: "bytes32" }],
		name: "CctpNonceAlreadyUsed",
		type: "error",
	},
] as const;

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
		cctpTokenMessenger: "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa",
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
		treasuryFundingTokens: [],
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

async function userIdFor(db: Database, address: string): Promise<string> {
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

	return user.id;
}

function concatHex(parts: Hex[]): Hex {
	return `0x${parts.map((part) => part.slice(2)).join("")}` as Hex;
}

function uintHex(value: bigint | number, bytes: number): Hex {
	return `0x${BigInt(value).toString(16).padStart(bytes * 2, "0")}` as Hex;
}

function addressBytes32(address: string): Hex {
	return `0x${"00".repeat(12)}${getAddress(address).slice(2).toLowerCase()}` as Hex;
}

function buildBurnBody(input: {
	amount: bigint;
	feeExecuted?: bigint;
	hookData: Hex;
	mintRecipient?: string;
}): Hex {
	return concatHex([
		uintHex(1, 4),
		addressBytes32(BURN_TOKEN),
		addressBytes32(input.mintRecipient ?? ROUTER),
		uintHex(input.amount, 32),
		addressBytes32(PRECLAIMER),
		uintHex(input.feeExecuted ?? 0n, 32),
		uintHex(input.feeExecuted ?? 0n, 32),
		uintHex(0, 32),
		input.hookData,
	]);
}

function buildCctpMessage(input: {
	amount: bigint;
	feeExecuted?: bigint;
	hookData: Hex;
	nonce: bigint;
	sourceDomain?: number;
}): Hex {
	const body = buildBurnBody(input);

	return concatHex([
		uintHex(1, 4),
		uintHex(input.sourceDomain ?? 0, 4),
		uintHex(1, 4),
		uintHex(input.nonce, 32),
		addressBytes32(TOKEN_MESSENGER),
		addressBytes32(TOKEN_MESSENGER),
		uintHex(0, 32),
		uintHex(1000, 4),
		uintHex(2000, 4),
		body,
	]);
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

	it("computes amountPCT for the exact minted post-fee amount", () => {
		const key = createAuditorKeypair(123_456n);
		const mintedAmount = 975_000n;
		const pct = computeOnrampAmountPCT(mintedAmount, [
			BigInt(key.publicKey[0]),
			BigInt(key.publicKey[1]),
		]);
		const encoded = encodeAbiParameters([{ type: "uint256[7]" }], [pct]);

		expect(
			decryptAuditorAmountPct(
				key.privateKey,
				Buffer.from(encoded.slice(2), "hex"),
			),
		).toBe(mintedAmount);
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

	it("onramp poller credits a complete attestation and re-associates a preclaimed intent", async () => {
		const sourceTxHash = `0x${"ef".repeat(32)}`;
		const wrongUserId = await userIdFor(db, PRECLAIMER);
		const realUserId = await userIdFor(db, REGISTERED);
		const key = createAuditorKeypair(987_654n);
		const publicKey = [
			BigInt(key.publicKey[0]),
			BigInt(key.publicKey[1]),
		] as [bigint, bigint];
		const message = buildCctpMessage({
			amount: 1_000_000n,
			feeExecuted: 25_000n,
			hookData: encodeOnrampHookData({
				pkX: publicKey[0],
				pkY: publicKey[1],
				user: REGISTERED,
			}),
			nonce: 11n,
		});
		const settlements: Parameters<OnrampRelayer["settleDeposit"]>[0][] = [];

		await db.insert(onrampIntents).values({
			destToken: "usdc",
			sourceChainId: 11_155_111,
			sourceDomain: 0,
			sourceTxHash,
			status: "burned",
			userAddress: PRECLAIMER.toLowerCase(),
			userId: wrongUserId,
			userPubKeyX: "1",
			userPubKeyY: "2",
		});

		const result = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, publicKey),
			config,
			iris: irisFor(sourceTxHash, message),
			limit: 200,
			relayer: {
				relayerAddress: RELAYER_ADDRESS,
				async settleDeposit(input) {
					settlements.push(input);
					return {
						alreadySettled: false,
						txHash: `0x${"12".repeat(32)}`,
					};
				},
			},
		});

		const [row] = await db
			.select()
			.from(onrampIntents)
			.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
			.limit(1);

		expect(result.credited).toBe(1);
		expect(row).toMatchObject({
			amount: "975000",
			error: null,
			settleTxHash: `0x${"12".repeat(32)}`,
			status: "credited",
			userAddress: REGISTERED.toLowerCase(),
			userId: realUserId,
			userPubKeyX: publicKey[0].toString(),
			userPubKeyY: publicKey[1].toString(),
		});
		expect(row?.cctpNonce).toBe(uintHex(11n, 32));
		expect(settlements).toHaveLength(1);
		const encodedPct = encodeAbiParameters(
			[{ type: "uint256[7]" }],
			[settlements[0]!.amountPCT],
		);
		expect(
			decryptAuditorAmountPct(
				key.privateKey,
				Buffer.from(encodedPct.slice(2), "hex"),
			),
		).toBe(975_000n);
	});

	it("onramp poller retries transient relayer failures without double-crediting", async () => {
		const sourceTxHash = `0x${"fa".repeat(32)}`;
		const userId = await userIdFor(db, REGISTERED);
		const key = createAuditorKeypair(222_333n);
		const publicKey = [
			BigInt(key.publicKey[0]),
			BigInt(key.publicKey[1]),
		] as [bigint, bigint];
		const message = buildCctpMessage({
			amount: 500_000n,
			hookData: encodeOnrampHookData({
				pkX: publicKey[0],
				pkY: publicKey[1],
				user: REGISTERED,
			}),
			nonce: 12n,
		});
		let settleCalls = 0;
		const relayer: OnrampRelayer = {
			relayerAddress: RELAYER_ADDRESS,
			async settleDeposit() {
				settleCalls += 1;
				if (settleCalls === 1) {
					throw new Error("rpc_timeout");
				}

				return {
					alreadySettled: false,
					txHash: `0x${"34".repeat(32)}`,
				};
			},
		};

		await db.insert(onrampIntents).values({
			destToken: "usdc",
			sourceChainId: 11_155_111,
			sourceDomain: 0,
			sourceTxHash,
			status: "burned",
			userAddress: REGISTERED.toLowerCase(),
			userId,
			userPubKeyX: publicKey[0].toString(),
			userPubKeyY: publicKey[1].toString(),
		});

		await expect(
			pollOnrampIntents(db, {
				chain: chainFor(REGISTERED, publicKey),
				config,
				iris: irisFor(sourceTxHash, message),
				limit: 200,
				relayer,
			}),
		).rejects.toThrow("rpc_timeout");
		const [retryableRow] = await db
			.select()
			.from(onrampIntents)
			.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
			.limit(1);
		expect(retryableRow).toMatchObject({
			settleTxHash: null,
			status: "attested",
		});

		const second = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, publicKey),
			config,
			iris: irisFor(sourceTxHash, message),
			limit: 200,
			relayer,
		});
		const [row] = await db
			.select()
			.from(onrampIntents)
			.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
			.limit(1);

		expect(second.credited).toBe(1);
		expect(settleCalls).toBe(2);
		expect(row).toMatchObject({
			amount: "500000",
			settleTxHash: `0x${"34".repeat(32)}`,
			status: "credited",
		});
	});

	it("relayer replay detection ignores ambiguous RPC error text", () => {
		const ambiguous = new Error("rpc timeout: nonce already used");
		const replay = new ContractFunctionRevertedError({
			abi: cctpReplayAbi,
			data: encodeErrorResult({
				abi: cctpReplayAbi,
				args: [uintHex(1n, 32)],
				errorName: "CctpNonceAlreadyUsed",
			}),
			functionName: "settleDeposit",
		});

		expect(isCctpMessageReplayError(ambiguous)).toBe(false);
		expect(isCctpMessageReplayError(replay)).toBe(true);
	});

	it("onramp poller treats relayer replay as an idempotent credit", async () => {
		const sourceTxHash = `0x${"ad".repeat(32)}`;
		const userId = await userIdFor(db, REGISTERED);
		const key = createAuditorKeypair(333_444n);
		const publicKey = [
			BigInt(key.publicKey[0]),
			BigInt(key.publicKey[1]),
		] as [bigint, bigint];
		const message = buildCctpMessage({
			amount: 250_000n,
			hookData: encodeOnrampHookData({
				pkX: publicKey[0],
				pkY: publicKey[1],
				user: REGISTERED,
			}),
			nonce: 14n,
		});

		await db.insert(onrampIntents).values({
			destToken: "usdc",
			sourceChainId: 11_155_111,
			sourceDomain: 0,
			sourceTxHash,
			status: "attested",
			userAddress: REGISTERED.toLowerCase(),
			userId,
			userPubKeyX: publicKey[0].toString(),
			userPubKeyY: publicKey[1].toString(),
		});

		const result = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, publicKey),
			config,
			iris: irisFor(sourceTxHash, message),
			limit: 200,
			relayer: {
				relayerAddress: RELAYER_ADDRESS,
				async settleDeposit() {
					return {
						alreadySettled: true,
						txHash: null,
					};
				},
			},
		});
		const [row] = await db
			.select()
			.from(onrampIntents)
			.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
			.limit(1);

		expect(result.credited).toBe(1);
		expect(row).toMatchObject({
			amount: "250000",
			settleTxHash: null,
			status: "credited",
		});
	});

	it("onramp poller parks unregistered recipients instead of revert-looping", async () => {
		const sourceTxHash = `0x${"bc".repeat(32)}`;
		const userId = await userIdFor(db, PRECLAIMER);
		const key = createAuditorKeypair(444_555n);
		const publicKey = [
			BigInt(key.publicKey[0]),
			BigInt(key.publicKey[1]),
		] as [bigint, bigint];
		const message = buildCctpMessage({
			amount: 750_000n,
			hookData: encodeOnrampHookData({
				pkX: publicKey[0],
				pkY: publicKey[1],
				user: UNREGISTERED,
			}),
			nonce: 13n,
		});
		let settleCalls = 0;

		await db.insert(onrampIntents).values({
			destToken: "usdc",
			sourceChainId: 11_155_111,
			sourceDomain: 0,
			sourceTxHash,
			status: "burned",
			userAddress: PRECLAIMER.toLowerCase(),
			userId,
			userPubKeyX: "1",
			userPubKeyY: "2",
		});

		const result = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, publicKey),
			config,
			iris: irisFor(sourceTxHash, message),
			limit: 200,
			relayer: {
				relayerAddress: RELAYER_ADDRESS,
				async settleDeposit() {
					settleCalls += 1;
					throw new Error("settle_not_expected");
				},
			},
		});
		const [row] = await db
			.select()
			.from(onrampIntents)
			.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
			.limit(1);

		expect(result.parked).toBe(1);
		expect(settleCalls).toBe(0);
		expect(row).toMatchObject({
			amount: "750000",
			error: "recipient_not_eerc_registered",
			status: "needs_onboarding",
			userAddress: UNREGISTERED.toLowerCase(),
		});
	});

	it("onramp poller does not settle a different Iris message after a nonce mismatch", async () => {
		const sourceTxHash = `0x${"ce".repeat(32)}`;
		const userId = await userIdFor(db, REGISTERED);
		const key = createAuditorKeypair(555_666n);
		const publicKey = [
			BigInt(key.publicKey[0]),
			BigInt(key.publicKey[1]),
		] as [bigint, bigint];
		const message = buildCctpMessage({
			amount: 650_000n,
			hookData: encodeOnrampHookData({
				pkX: publicKey[0],
				pkY: publicKey[1],
				user: REGISTERED,
			}),
			nonce: 22n,
		});
		let settleCalls = 0;

		await db.insert(onrampIntents).values({
			cctpNonce: uintHex(99n, 32),
			destToken: "usdc",
			sourceChainId: 11_155_111,
			sourceDomain: 0,
			sourceTxHash,
			status: "burned",
			userAddress: REGISTERED.toLowerCase(),
			userId,
			userPubKeyX: publicKey[0].toString(),
			userPubKeyY: publicKey[1].toString(),
		});

		const result = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, publicKey),
			config,
			iris: irisFor(sourceTxHash, message),
			limit: 200,
			relayer: {
				relayerAddress: RELAYER_ADDRESS,
				async settleDeposit() {
					settleCalls += 1;
					throw new Error("settle_not_expected");
				},
			},
		});
		const [row] = await db
			.select()
			.from(onrampIntents)
			.where(eq(onrampIntents.sourceTxHash, sourceTxHash))
			.limit(1);

		expect(result.credited).toBe(0);
		expect(settleCalls).toBe(0);
		expect(row).toMatchObject({
			amount: null,
			cctpNonce: uintHex(99n, 32),
			settleTxHash: null,
			status: "burned",
		});
	});

	it("onramp poller no-ops cleanly until the router address is configured", async () => {
		let irisCalls = 0;
		const result = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, [PK_X, PK_Y]),
			config: {
				...config,
				autoDepositRouterAddress: null,
			},
			iris: {
				async getMessages() {
					irisCalls += 1;
					return [];
				},
			},
			relayer: {
				relayerAddress: RELAYER_ADDRESS,
				async settleDeposit() {
					throw new Error("settle_not_expected");
				},
			},
		});

		expect(result).toMatchObject({
			polled: 0,
			routerConfigured: false,
		});
		expect(irisCalls).toBe(0);
	});

	it("onramp poller no-ops cleanly until the relayer key is configured", async () => {
		let irisCalls = 0;
		const logs: string[] = [];
		const result = await pollOnrampIntents(db, {
			chain: chainFor(REGISTERED, [PK_X, PK_Y]),
			config: {
				...config,
				relayerPrivateKey: undefined,
			},
			iris: {
				async getMessages() {
					irisCalls += 1;
					return [];
				},
			},
			logger: {
				info(_bindings, message) {
					logs.push(message);
				},
			},
			relayer: {
				relayerAddress: null,
				async settleDeposit() {
					throw new Error("settle_not_expected");
				},
			},
		});

		expect(result).toMatchObject({
			polled: 0,
			relayerConfigured: false,
			routerConfigured: true,
		});
		expect(irisCalls).toBe(0);
		expect(logs).toEqual([
			"onramp poller skipped because required relayer config is missing",
		]);
	});
});

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
				? [
						{
							attestation: ATTESTATION,
							eventNonce: uintHex(11n, 32),
							message,
							status: "complete",
						},
					]
				: [];
		},
	};
}
