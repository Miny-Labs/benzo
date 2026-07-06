import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Abi, Address } from "viem";
import { decodeEventLog, encodeAbiParameters, getAddress, isAddress } from "viem";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { chainCursor, events } from "../db/schema.js";
import { encryptedErcAbi, registrarAbi } from "./abi.js";
import type { ChainBlock, ChainLog, ChainLogSource } from "./chain.js";

export type IndexerRunOptions = {
	chain: ChainLogSource;
	config: ApiConfig;
	db: Database;
	fromBlock?: bigint;
	logger?: Pick<FastifyBaseLogger, "debug" | "info" | "warn">;
	toBlock?: bigint;
};

export type IndexerRunResult = {
	contracts: Array<{
		address: string;
		insertedOrUpdated: number;
		scannedFrom: string | null;
		scannedTo: string | null;
	}>;
	latestBlock: string;
	confirmedBlock: string;
};

type IndexedContract = {
	abi: Abi;
	address: Address;
	name: "EncryptedERC" | "Registrar";
};

type DecodedEvent = {
	amountPct: Buffer | null;
	ciphertext: Buffer[];
	eventName: string;
	fromAddr: string | null;
	toAddr: string | null;
};

type EventInsert = typeof events.$inferInsert;

export function getIndexedContracts(config: ApiConfig): IndexedContract[] {
	return [
		{
			abi: encryptedErcAbi,
			address: normalizeAddress(config.eercEncryptedErcAddress) as Address,
			name: "EncryptedERC",
		},
		{
			abi: registrarAbi,
			address: normalizeAddress(config.eercRegistrarAddress) as Address,
			name: "Registrar",
		},
	];
}

export async function runIndexerOnce(
	options: IndexerRunOptions,
): Promise<IndexerRunResult> {
	const latestBlock = await options.chain.getBlockNumber();
	const confirmedBlock =
		latestBlock - BigInt(options.config.indexerConfirmations);
	const targetBlock =
		options.toBlock === undefined
			? confirmedBlock
			: minBigint(confirmedBlock, options.toBlock);
	const startBlock = options.fromBlock ?? options.config.indexerStartBlock;
	const contracts = getIndexedContracts(options.config);
	const contractResults: IndexerRunResult["contracts"] = [];

	if (targetBlock < startBlock) {
		return {
			confirmedBlock: targetBlock.toString(),
			contracts: contracts.map((contract) => ({
				address: contract.address.toLowerCase(),
				insertedOrUpdated: 0,
				scannedFrom: null,
				scannedTo: null,
			})),
			latestBlock: latestBlock.toString(),
		};
	}

	for (const contract of contracts) {
		contractResults.push(
			await scanContract({
				...options,
				contract,
				replaceScannedWindows: options.fromBlock !== undefined,
				startBlock,
				targetBlock,
			}),
		);
	}

	return {
		confirmedBlock: targetBlock.toString(),
		contracts: contractResults,
		latestBlock: latestBlock.toString(),
	};
}

async function scanContract(
	options: IndexerRunOptions & {
		contract: IndexedContract;
		replaceScannedWindows: boolean;
		startBlock: bigint;
		targetBlock: bigint;
	},
): Promise<IndexerRunResult["contracts"][number]> {
	const contractAddress = options.contract.address.toLowerCase();
	const existingCursor = options.fromBlock
		? undefined
		: await loadCursor(options.db, contractAddress);
	let cursor = existingCursor ?? {
		lastBlock: options.startBlock - 1n,
		lastBlockHash: await getPreviousBlockHash(
			options.chain,
			options.startBlock - 1n,
		),
	};
	let insertedOrUpdated = 0;
	let scannedFrom: bigint | null = null;
	let scannedTo: bigint | null = null;

	while (cursor.lastBlock < options.targetBlock) {
		const fromBlock = cursor.lastBlock + 1n;
		const toBlock = minBigint(
			cursor.lastBlock + BigInt(options.config.indexerMaxWindowBlocks),
			options.targetBlock,
		);

		if (await boundaryNeedsRescan(options.chain, cursor, fromBlock)) {
			cursor = await rewindCursorWindow({
				...options,
				contractAddress,
				cursor,
			});
			continue;
		}

		const windowResult = await scanWindow({
			...options,
			contractAddress,
			fromBlock,
			toBlock,
		});
		const lastBlockHash = windowResult.lastBlock.hash;

		await options.db.transaction(async (tx) => {
			if (options.replaceScannedWindows) {
				await deleteEventsInWindow(tx, contractAddress, fromBlock, toBlock);
			}

			if (windowResult.events.length > 0) {
				await upsertEvents(tx, windowResult.events);
			}

			await tx
				.insert(chainCursor)
				.values({
					contract: contractAddress,
					lastBlock: toBlock,
					lastBlockHash,
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					set: {
						lastBlock: toBlock,
						lastBlockHash,
						updatedAt: new Date(),
					},
					target: chainCursor.contract,
				});
		});

		insertedOrUpdated += windowResult.events.length;
		scannedFrom ??= fromBlock;
		scannedTo = toBlock;
		cursor = {
			lastBlock: toBlock,
			lastBlockHash,
		};
		options.logger?.debug(
			{
				contract: contractAddress,
				fromBlock: fromBlock.toString(),
				toBlock: toBlock.toString(),
			},
			"indexed eerc event window",
		);
	}

	return {
		address: contractAddress,
		insertedOrUpdated,
		scannedFrom: scannedFrom?.toString() ?? null,
		scannedTo: scannedTo?.toString() ?? null,
	};
}

async function scanWindow(options: IndexerRunOptions & {
	contract: IndexedContract;
	contractAddress: string;
	fromBlock: bigint;
	toBlock: bigint;
}): Promise<{
	events: EventInsert[];
	lastBlock: ChainBlock;
}> {
	const [logs, lastBlock] = await Promise.all([
		options.chain.getLogs({
			address: options.contract.address,
			fromBlock: options.fromBlock,
			toBlock: options.toBlock,
		}),
		options.chain.getBlock(options.toBlock),
	]);
	const blockCache = new Map<bigint, ChainBlock>([
		[lastBlock.number, lastBlock],
	]);
	const indexedEvents: EventInsert[] = [];

	for (const log of logs) {
		const decoded = decodeIndexedEvent(options.contract, log);

		if (!decoded) {
			continue;
		}

		const block = await getCachedBlock(options.chain, blockCache, log.blockNumber);

		indexedEvents.push({
			amountPct: decoded.amountPct,
			blockHash: log.blockHash.toLowerCase(),
			blockNumber: log.blockNumber,
			blockTime: new Date(Number(block.timestamp) * 1_000),
			ciphertext: decoded.ciphertext,
			contract: options.contractAddress,
			eventName: decoded.eventName,
			fromAddr: decoded.fromAddr,
			logIndex: log.logIndex,
			rawLog: serializeRawLog(log),
			toAddr: decoded.toAddr,
			txHash: log.transactionHash.toLowerCase(),
		});
	}

	return {
		events: indexedEvents,
		lastBlock,
	};
}

function decodeIndexedEvent(
	contract: IndexedContract,
	log: ChainLog,
): DecodedEvent | null {
	try {
		const decoded = decodeEventLog({
			abi: contract.abi,
			data: log.data,
			topics: log.topics,
		}) as {
			args: Record<string, unknown> | readonly unknown[] | undefined;
			eventName: string;
		};
		const args: Record<string, unknown> =
			typeof decoded.args === "object" &&
			decoded.args !== null &&
			!Array.isArray(decoded.args)
				? (decoded.args as Record<string, unknown>)
				: {};

		switch (decoded.eventName) {
			case "PrivateTransfer": {
				return {
					amountPct: encodeUint256Array7(args.auditorPCT),
					ciphertext: [],
					eventName: decoded.eventName,
					fromAddr: normalizeAddressArg(args.from),
					toAddr: normalizeAddressArg(args.to),
				};
			}
			case "PrivateMint": {
				const user = normalizeAddressArg(args.user);

				return {
					amountPct: encodeUint256Array7(args.auditorPCT),
					ciphertext: [],
					eventName: decoded.eventName,
					fromAddr: null,
					toAddr: user,
				};
			}
			case "PrivateBurn": {
				const user = normalizeAddressArg(args.user);

				return {
					amountPct: encodeUint256Array7(args.auditorPCT),
					ciphertext: [],
					eventName: decoded.eventName,
					fromAddr: user,
					toAddr: null,
				};
			}
			case "Withdraw": {
				const user = normalizeAddressArg(args.user);

				return {
					amountPct: encodeUint256Array7(args.auditorPCT),
					ciphertext: [],
					eventName: decoded.eventName,
					fromAddr: user,
					toAddr: user,
				};
			}
			case "Deposit":
			case "Register": {
				const user = normalizeAddressArg(args.user);

				return {
					amountPct: null,
					ciphertext: [],
					eventName: decoded.eventName,
					fromAddr: user,
					toAddr: user,
				};
			}
			case "AuditorChanged": {
				return {
					amountPct: null,
					ciphertext: [],
					eventName: decoded.eventName,
					fromAddr: normalizeAddressArg(args.oldAuditor),
					toAddr: normalizeAddressArg(args.newAuditor),
				};
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

async function boundaryNeedsRescan(
	chain: ChainLogSource,
	cursor: { lastBlock: bigint; lastBlockHash: string | null },
	fromBlock: bigint,
): Promise<boolean> {
	if (!cursor.lastBlockHash || cursor.lastBlock < 0n) {
		return false;
	}

	const childBlock = await chain.getBlock(fromBlock);
	return childBlock.parentHash.toLowerCase() !== cursor.lastBlockHash.toLowerCase();
}

async function rewindCursorWindow(options: IndexerRunOptions & {
	contractAddress: string;
	cursor: { lastBlock: bigint; lastBlockHash: string | null };
	startBlock: bigint;
}): Promise<{ lastBlock: bigint; lastBlockHash: string | null }> {
	const rewindTo = maxBigint(
		options.startBlock,
		options.cursor.lastBlock - BigInt(options.config.indexerMaxWindowBlocks) + 1n,
	);
	const previousBlock = rewindTo - 1n;
	const previousHash = await getPreviousBlockHash(options.chain, previousBlock);

	await options.db.transaction(async (tx) => {
		await deleteEventsInWindow(
			tx,
			options.contractAddress,
			rewindTo,
			options.cursor.lastBlock,
		);
		await tx
			.insert(chainCursor)
			.values({
				contract: options.contractAddress,
				lastBlock: previousBlock,
				lastBlockHash: previousHash,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				set: {
					lastBlock: previousBlock,
					lastBlockHash: previousHash,
					updatedAt: new Date(),
				},
				target: chainCursor.contract,
			});
	});

	options.logger?.warn(
		{
			contract: options.contractAddress,
			rewindTo: rewindTo.toString(),
		},
		"eerc indexer parent hash mismatch; rewound cursor window",
	);

	return {
		lastBlock: previousBlock,
		lastBlockHash: previousHash,
	};
}

async function loadCursor(
	db: Database,
	contractAddress: string,
): Promise<{ lastBlock: bigint; lastBlockHash: string | null } | undefined> {
	const [row] = await db
		.select({
			lastBlock: chainCursor.lastBlock,
			lastBlockHash: chainCursor.lastBlockHash,
		})
		.from(chainCursor)
		.where(eq(chainCursor.contract, contractAddress))
		.limit(1);

	return row;
}

async function getPreviousBlockHash(
	chain: ChainLogSource,
	blockNumber: bigint,
): Promise<string | null> {
	if (blockNumber < 0n) {
		return null;
	}

	return (await chain.getBlock(blockNumber)).hash;
}

async function getCachedBlock(
	chain: ChainLogSource,
	cache: Map<bigint, ChainBlock>,
	blockNumber: bigint,
): Promise<ChainBlock> {
	const cached = cache.get(blockNumber);

	if (cached) {
		return cached;
	}

	const block = await chain.getBlock(blockNumber);
	cache.set(blockNumber, block);
	return block;
}

async function upsertEvents(
	db: Database,
	rows: EventInsert[],
): Promise<void> {
	await db
		.insert(events)
		.values(rows)
		.onConflictDoUpdate({
			set: {
				amountPct: sql`excluded.amount_pct`,
				blockHash: sql`excluded.block_hash`,
				blockNumber: sql`excluded.block_number`,
				blockTime: sql`excluded.block_time`,
				ciphertext: sql`excluded.ciphertext`,
				contract: sql`excluded.contract`,
				eventName: sql`excluded.event_name`,
				fromAddr: sql`excluded.from_addr`,
				indexedAt: new Date(),
				rawLog: sql`excluded.raw_log`,
				toAddr: sql`excluded.to_addr`,
			},
			target: [events.txHash, events.logIndex],
		});
}

async function deleteEventsInWindow(
	db: Database,
	contractAddress: string,
	fromBlock: bigint,
	toBlock: bigint,
): Promise<void> {
	await db
		.delete(events)
		.where(
			and(
				eq(events.contract, contractAddress),
				gte(events.blockNumber, fromBlock),
				lte(events.blockNumber, toBlock),
			),
		);
}

function serializeRawLog(log: ChainLog): Record<string, unknown> {
	return {
		address: log.address.toLowerCase(),
		blockHash: log.blockHash.toLowerCase(),
		blockNumber: log.blockNumber.toString(),
		data: log.data.toLowerCase(),
		logIndex: log.logIndex,
		topics: log.topics.map((topic) => topic.toLowerCase()),
		transactionHash: log.transactionHash.toLowerCase(),
	};
}

function encodeUint256Array7(value: unknown): Buffer {
	if (!Array.isArray(value) || value.length !== 7) {
		throw new Error("expected uint256[7] event argument");
	}

	const tuple = value.map((item) => BigInt(item));
	const [first, second, third, fourth, fifth, sixth, seventh] = tuple;

	if (
		first === undefined ||
		second === undefined ||
		third === undefined ||
		fourth === undefined ||
		fifth === undefined ||
		sixth === undefined ||
		seventh === undefined
	) {
		throw new Error("expected uint256[7] event argument");
	}

	const encoded = encodeAbiParameters(
		[{ type: "uint256[7]" }],
		[[first, second, third, fourth, fifth, sixth, seventh]],
	);

	return Buffer.from(encoded.slice(2), "hex");
}

function normalizeAddressArg(value: unknown): string {
	if (typeof value !== "string" || !isAddress(value, { strict: false })) {
		throw new Error("expected address event argument");
	}

	return normalizeAddress(value);
}

function normalizeAddress(address: string): string {
	return getAddress(address).toLowerCase();
}

function minBigint(a: bigint, b: bigint): bigint {
	return a < b ? a : b;
}

function maxBigint(a: bigint, b: bigint): bigint {
	return a > b ? a : b;
}
