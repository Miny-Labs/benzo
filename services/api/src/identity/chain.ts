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

export function createInMemoryIdentityChainClient(): IdentityChainClient {
	return new InMemoryIdentityChainClient();
}
