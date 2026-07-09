import {
	type PrivateKeyAccount,
	type PublicClient,
	type WalletClient,
	createPublicClient,
	createWalletClient,
	formatEther,
	http,
} from "viem";
import type { E2EConfig } from "./config.js";
import { type NamedAccountKey, loadAccount } from "../fixtures/accounts.js";

export function createPublicClientFor(config: E2EConfig): PublicClient {
	return createPublicClient({
		chain: config.chain,
		transport: http(config.rpcUrl),
	});
}

export function createWalletClientFor(
	config: E2EConfig,
	account: PrivateKeyAccount,
): WalletClient {
	return createWalletClient({
		account,
		chain: config.chain,
		transport: http(config.rpcUrl),
	});
}

export type AccountRequirement = {
	envVar: NamedAccountKey;
	/** Minimum native (gas) balance in wei; default 0n means "presence only". */
	minNativeWei?: bigint;
	faucet?: string;
};

export type PreflightAccounts = Partial<
	Record<NamedAccountKey, PrivateKeyAccount>
>;

export type Preflight =
	| { ok: true; client: PublicClient; accounts: PreflightAccounts }
	| { ok: false; reason: string };

export type ReadyPreflight = Extract<Preflight, { ok: true }>;

/**
 * Type guard used at the top of every live `it`. Skips the test (with the
 * precise preflight reason) when accounts are missing/underfunded, and narrows
 * `pf` to the ready shape for the rest of the test body.
 */
export function isReady(
	pf: Preflight | undefined,
	skip: (note?: string) => void,
): pf is ReadyPreflight {
	if (pf === undefined) {
		skip("preflight has not run");
		return false;
	}
	if (!pf.ok) {
		skip(pf.reason);
		return false;
	}
	return true;
}

/**
 * Idempotent funded-account guard. Loads each required key from the environment
 * and checks its native balance on the target chain via a single read-only RPC
 * per account, so re-running an already-funded suite is a no-op. On the first
 * missing key or underfunded account it returns a precise, actionable reason
 * (`Fund 0x… on fuji …`) the suite turns into a clean `ctx.skip`, never a
 * failure. Returns the resolved accounts + a shared client when everything is
 * ready.
 */
export async function preflightLive(
	config: E2EConfig,
	requirements: AccountRequirement[],
): Promise<Preflight> {
	const client = createPublicClientFor(config);
	const accounts: PreflightAccounts = {};

	for (const requirement of requirements) {
		let account: PrivateKeyAccount;
		try {
			account = loadAccount(requirement.envVar);
		} catch (error) {
			return {
				ok: false,
				reason: `${(error as Error).message}. Set ${requirement.envVar} to run this suite on ${config.network}.`,
			};
		}

		const min = requirement.minNativeWei ?? 0n;
		if (min > 0n) {
			const balance = await client.getBalance({ address: account.address });
			if (balance < min) {
				const faucet = requirement.faucet ? ` (faucet: ${requirement.faucet})` : "";
				return {
					ok: false,
					reason: `Fund ${account.address} on ${config.network} with at least ${formatEther(min)} ${config.chain.nativeCurrency.symbol} (has ${formatEther(balance)})${faucet}.`,
				};
			}
		}

		accounts[requirement.envVar] = account;
	}

	return { ok: true, client, accounts };
}
