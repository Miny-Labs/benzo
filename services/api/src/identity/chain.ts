import {
	BaseError,
	ContractFunctionRevertedError,
	createPublicClient,
	createWalletClient,
	getAddress,
	http,
	zeroAddress,
	type Address,
	type Hex,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiConfig } from "../config.js";

export type ChainHandleSource = "chain";

export type HandleResolution = {
	address: string | null;
	registeredOnEerc: boolean;
	source: ChainHandleSource;
};

export type ClaimedHandle = {
	address: string;
	registeredOnEerc: boolean;
	source: ChainHandleSource;
};

export type IdentityChainClient = {
	claimHandle: (input: {
		handle: string;
		ownerAddress: string;
	}) => Promise<ClaimedHandle>;
	getRegistrationStatuses: (
		addresses: string[],
	) => Promise<Map<string, boolean>>;
	resolveHandle: (handle: string) => Promise<HandleResolution>;
};

export class HandleTakenError extends Error {
	constructor(handle: string) {
		super(`handle already claimed: ${handle}`);
		this.name = "HandleTakenError";
	}
}

export class AddressAlreadyHasHandleError extends Error {
	constructor(address: string) {
		super(`address already has a handle: ${address}`);
		this.name = "AddressAlreadyHasHandleError";
	}
}

export class InMemoryIdentityChainClient implements IdentityChainClient {
	readonly #handleOwners = new Map<string, string>();
	readonly #ownerHandles = new Map<string, string>();
	readonly #registeredAddresses = new Set<string>();

	constructor(input: { registeredAddresses?: string[] } = {}) {
		for (const address of input.registeredAddresses ?? []) {
			this.#registeredAddresses.add(address.toLowerCase());
		}
	}

	async claimHandle(input: {
		handle: string;
		ownerAddress: string;
	}): Promise<ClaimedHandle> {
		const ownerAddress = input.ownerAddress.toLowerCase();
		const existingOwner = this.#handleOwners.get(input.handle);

		if (existingOwner && existingOwner !== ownerAddress) {
			throw new HandleTakenError(input.handle);
		}

		const existingHandle = this.#ownerHandles.get(ownerAddress);

		if (existingHandle && existingHandle !== input.handle) {
			throw new AddressAlreadyHasHandleError(ownerAddress);
		}

		this.#handleOwners.set(input.handle, ownerAddress);
		this.#ownerHandles.set(ownerAddress, input.handle);

		return {
			address: ownerAddress,
			registeredOnEerc: this.#registeredAddresses.has(ownerAddress),
			source: "chain",
		};
	}

	async getRegistrationStatuses(
		addresses: string[],
	): Promise<Map<string, boolean>> {
		return new Map(
			addresses.map((address) => [
				address.toLowerCase(),
				this.#registeredAddresses.has(address.toLowerCase()),
			]),
		);
	}

	async resolveHandle(handle: string): Promise<HandleResolution> {
		const address = this.#handleOwners.get(handle) ?? null;

		return {
			address,
			registeredOnEerc: address
				? this.#registeredAddresses.has(address.toLowerCase())
				: false,
			source: "chain",
		};
	}

	setRegistered(address: string, registered: boolean): void {
		const normalizedAddress = address.toLowerCase();

		if (registered) {
			this.#registeredAddresses.add(normalizedAddress);
			return;
		}

		this.#registeredAddresses.delete(normalizedAddress);
	}
}

const registrarAbi = [
	{
		inputs: [{ name: "user", type: "address" }],
		name: "isUserRegistered",
		outputs: [{ name: "registered", type: "bool" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

const handleRegistryAbi = [
	{
		inputs: [{ name: "handle", type: "string" }],
		name: "claim",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [{ name: "handle", type: "string" }],
		name: "resolve",
		outputs: [{ name: "owner", type: "address" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ name: "handleHash", type: "bytes32" }],
		name: "ownerOf",
		outputs: [{ name: "owner", type: "address" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ name: "owner", type: "address" }],
		name: "handleOf",
		outputs: [{ name: "handle", type: "string" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ name: "handleHash", type: "bytes32" }],
		name: "HandleTaken",
		type: "error",
	},
	{
		inputs: [{ name: "owner", type: "address" }],
		name: "CallerAlreadyHasHandle",
		type: "error",
	},
] as const;

export class OnChainIdentityChainClient implements IdentityChainClient {
	readonly #account: ReturnType<typeof privateKeyToAccount>;
	readonly #config: ApiConfig;
	readonly #publicClient: PublicClient;
	readonly #walletClient: ReturnType<typeof createWalletClient>;

	constructor(config: ApiConfig) {
		this.#config = config;
		this.#account = privateKeyToAccount(config.opsPrivateKey as Hex);
		this.#publicClient = createPublicClient({
			transport: http(config.benzonetRpcUrl),
		});
		this.#walletClient = createWalletClient({
			account: this.#account,
			transport: http(config.benzonetRpcUrl),
		});
	}

	async claimHandle(input: {
		handle: string;
		ownerAddress: string;
	}): Promise<ClaimedHandle> {
		const registryAddress = this.#requireHandleRegistryAddress();
		const ownerAddress = normalizeAddress(input.ownerAddress);
		const ownerAddressKey = ownerAddress.toLowerCase();
		const accountAddressKey = this.#account.address.toLowerCase();

		if (ownerAddressKey !== accountAddressKey) {
			throw new Error(
				`handle registry claim owner mismatch: configured signer ${accountAddressKey} cannot claim for ${ownerAddressKey}`,
			);
		}

		let shouldWriteClaim = true;

		try {
			const existingOwner = await this.#readHandleOwner(
				registryAddress,
				input.handle,
			);

			if (existingOwner.toLowerCase() !== zeroAddress) {
				if (existingOwner.toLowerCase() === ownerAddressKey) {
					shouldWriteClaim = false;
				} else {
					throw new HandleTakenError(input.handle);
				}
			}

			if (shouldWriteClaim) {
				const existingHandle = await this.#readOwnerHandle(
					registryAddress,
					ownerAddress,
				);

				if (existingHandle.length > 0) {
					if (existingHandle === input.handle) {
						shouldWriteClaim = false;
					} else {
						throw new AddressAlreadyHasHandleError(ownerAddressKey);
					}
				}
			}

			if (shouldWriteClaim) {
				await this.#publicClient.simulateContract({
					abi: handleRegistryAbi,
					account: this.#account,
					address: registryAddress,
					args: [input.handle],
					functionName: "claim",
				});

				const txHash = await this.#walletClient.writeContract({
					abi: handleRegistryAbi,
					account: this.#account,
					address: registryAddress,
					args: [input.handle],
					chain: null,
					functionName: "claim",
				});
				const receipt = await this.#publicClient.waitForTransactionReceipt({
					confirmations: 1,
					hash: txHash,
				});

				if (receipt.status === "reverted") {
					throw new Error(`handle claim transaction reverted: ${txHash}`);
				}
			}
		} catch (error) {
			mapHandleRegistryWriteError(error, input.handle, ownerAddressKey);
		}

		return this.#claimedHandle(ownerAddressKey);
	}

	async getRegistrationStatuses(
		addresses: string[],
	): Promise<Map<string, boolean>> {
		const statuses = new Map<string, boolean>();
		const uniqueAddresses = [
			...new Set(addresses.map((address) => normalizeAddress(address))),
		];

		for (const address of uniqueAddresses) {
			try {
				const registered = await this.#publicClient.readContract({
					abi: registrarAbi,
					address: normalizeAddress(this.#config.eercRegistrarAddress),
					args: [address],
					functionName: "isUserRegistered",
				});

				statuses.set(address.toLowerCase(), registered);
			} catch (error) {
				throw new Error(
					`failed to read eERC registration status for ${address.toLowerCase()}`,
					{ cause: error },
				);
			}
		}

		return statuses;
	}

	async resolveHandle(handle: string): Promise<HandleResolution> {
		const registryAddress = this.#handleRegistryAddress();

		if (!registryAddress) {
			return {
				address: null,
				registeredOnEerc: false,
				source: "chain",
			};
		}

		let ownerAddress: Address;

		try {
			ownerAddress = await this.#readHandleOwner(registryAddress, handle);
		} catch (error) {
			throw new Error(`failed to resolve handle on chain: ${handle}`, {
				cause: error,
			});
		}

		const normalizedOwnerAddress = ownerAddress.toLowerCase();

		if (normalizedOwnerAddress === zeroAddress) {
			return {
				address: null,
				registeredOnEerc: false,
				source: "chain",
			};
		}

		const registrations = await this.getRegistrationStatuses([ownerAddress]);

		return {
			address: normalizedOwnerAddress,
			registeredOnEerc: registrations.get(normalizedOwnerAddress) ?? false,
			source: "chain",
		};
	}

	#handleRegistryAddress(): Address | null {
		return this.#config.handleRegistryAddress
			? normalizeAddress(this.#config.handleRegistryAddress)
			: null;
	}

	#requireHandleRegistryAddress(): Address {
		const registryAddress = this.#handleRegistryAddress();

		if (!registryAddress) {
			throw new Error("handle registry not configured");
		}

		return registryAddress;
	}

	async #readHandleOwner(
		registryAddress: Address,
		handle: string,
	): Promise<Address> {
		return this.#publicClient.readContract({
			abi: handleRegistryAbi,
			address: registryAddress,
			args: [handle],
			functionName: "resolve",
		});
	}

	async #readOwnerHandle(
		registryAddress: Address,
		ownerAddress: Address,
	): Promise<string> {
		return this.#publicClient.readContract({
			abi: handleRegistryAbi,
			address: registryAddress,
			args: [ownerAddress],
			functionName: "handleOf",
		});
	}

	async #claimedHandle(ownerAddress: string): Promise<ClaimedHandle> {
		const registrations = await this.getRegistrationStatuses([ownerAddress]);

		return {
			address: ownerAddress,
			registeredOnEerc: registrations.get(ownerAddress) ?? false,
			source: "chain",
		};
	}
}

export function createInMemoryIdentityChainClient(): IdentityChainClient {
	return new InMemoryIdentityChainClient();
}

export function createOnChainIdentityChainClient(
	config: ApiConfig,
): IdentityChainClient {
	return new OnChainIdentityChainClient(config);
}

export function isInMemoryIdentityChainClient(
	identityChain: IdentityChainClient,
): boolean {
	return identityChain instanceof InMemoryIdentityChainClient;
}

function normalizeAddress(address: string): Address {
	return getAddress(address) as Address;
}

function mapHandleRegistryWriteError(
	error: unknown,
	handle: string,
	ownerAddress: string,
): never {
	if (error instanceof HandleTakenError) {
		throw error;
	}

	if (error instanceof AddressAlreadyHasHandleError) {
		throw error;
	}

	const revertName = readContractRevertName(error);

	if (revertName === "HandleTaken") {
		throw new HandleTakenError(handle);
	}

	if (revertName === "CallerAlreadyHasHandle") {
		throw new AddressAlreadyHasHandleError(ownerAddress);
	}

	throw new Error(`failed to claim handle on chain: ${handle}`, {
		cause: error,
	});
}

function readContractRevertName(error: unknown): string | undefined {
	if (!(error instanceof BaseError)) {
		return undefined;
	}

	const revertError = error.walk(
		(cause) => cause instanceof ContractFunctionRevertedError,
	);

	if (!(revertError instanceof ContractFunctionRevertedError)) {
		return undefined;
	}

	return revertError.data?.errorName;
}
