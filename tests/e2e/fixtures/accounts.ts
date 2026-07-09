import {
	type PrivateKeyAccount,
	generatePrivateKey,
	privateKeyToAccount,
} from "viem/accounts";

// Named funded testnet accounts for the live suites. Private keys are ALWAYS
// read from the environment (CI secrets / a local .env) and are never committed.
// The addresses each key is expected to derive to (documented for operators):
//   BENZO_ONRAMP_USER_KEY -> 0x5291aD86... (the 0-AVAX onramp recipient)
//   BENZO_RELAYER_KEY      -> 0x984E0751... (the gas-sponsoring settlement relayer)
//   BENZO_DEPLOYER_KEY     -> 0x3cdff5fD... (the eERC owner / auditor operator)
export type NamedAccountKey =
	| "BENZO_ONRAMP_USER_KEY"
	| "BENZO_RELAYER_KEY"
	| "BENZO_DEPLOYER_KEY";

function normalizePrivateKey(raw: string, envVar: NamedAccountKey): `0x${string}` {
	const trimmed = raw.trim();
	const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(`${envVar} must be a 32-byte hex private key`);
	}
	return hex as `0x${string}`;
}

/**
 * Resolve a named account from its env-held private key. Throws a precise,
 * env-var-named error when unset so preflight can surface exactly what to set;
 * never returns a fabricated key.
 */
export function loadAccount(envVar: NamedAccountKey): PrivateKeyAccount {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") {
		throw new Error(`Missing ${envVar} (set the funded testnet key to run live)`);
	}
	return privateKeyToAccount(normalizePrivateKey(raw, envVar));
}

/** True when a named account's key is present, without deriving it. */
export function hasAccount(envVar: NamedAccountKey): boolean {
	const raw = process.env[envVar];
	return raw !== undefined && raw !== "";
}

const seenFreshAddresses = new Set<string>();

/**
 * Mint a brand-new random EOA for a single test. Backed by a CSPRNG, so
 * collisions are cryptographically impossible; we additionally track every
 * address handed out this process and regenerate on the (never-observed)
 * collision, so a fresh EOA can never clash on eERC registration within a run.
 */
export function freshEoa(): PrivateKeyAccount {
	for (;;) {
		const account = privateKeyToAccount(generatePrivateKey());
		const key = account.address.toLowerCase();
		if (!seenFreshAddresses.has(key)) {
			seenFreshAddresses.add(key);
			return account;
		}
	}
}
