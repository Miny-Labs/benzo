import type { Address, Hex, PublicClient } from "viem";

export type ChainBlock = {
	hash: Hex;
	number: bigint;
	parentHash: Hex;
	timestamp: bigint;
};

export type ChainLog = {
	address: Address;
	blockHash: Hex;
	blockNumber: bigint;
	data: Hex;
	logIndex: number;
	topics: [Hex, ...Hex[]] | [];
	transactionHash: Hex;
};

export type GetLogsInput = {
	address: Address;
	fromBlock: bigint;
	toBlock: bigint;
};

export type ChainLogSource = {
	getBlock(blockNumber: bigint): Promise<ChainBlock>;
	getBlockNumber(): Promise<bigint>;
	getLogs(input: GetLogsInput): Promise<ChainLog[]>;
};

export function createViemChainLogSource(
	publicClient: PublicClient,
): ChainLogSource {
	return {
		async getBlock(blockNumber) {
			const block = await publicClient.getBlock({ blockNumber });

			if (!block.hash) {
				throw new Error(`block ${blockNumber.toString()} did not include a hash`);
			}

			return {
				hash: block.hash,
				number: block.number ?? blockNumber,
				parentHash: block.parentHash,
				timestamp: block.timestamp,
			};
		},
		getBlockNumber() {
			return publicClient.getBlockNumber();
		},
		async getLogs(input) {
			const logs = await publicClient.getLogs({
				address: input.address,
				fromBlock: input.fromBlock,
				toBlock: input.toBlock,
			});

			return logs.map((log) => {
				if (
					log.blockHash === null ||
					log.blockNumber === null ||
					log.logIndex === null ||
					log.transactionHash === null
				) {
					throw new Error("received an unmined log while indexing confirmed blocks");
				}

				return {
					address: log.address,
					blockHash: log.blockHash,
					blockNumber: log.blockNumber,
					data: log.data,
					logIndex: log.logIndex,
					topics: log.topics,
					transactionHash: log.transactionHash,
				};
			});
		},
	};
}
