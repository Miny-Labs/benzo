import type { CeremonyValidation } from "../ceremony/marker";

// #120 — mainnet deploy GUARDRAILS.
//
// Pure (no hardhat, no network I/O) so it is exhaustively unit-testable and, by
// construction, cannot broadcast a transaction. deploy-mainnet.ts gathers the
// live values (RPC chainId, balances, the ceremony marker validation) and calls
// assertMainnetGuardrails BEFORE any deploy. Any failed guardrail throws a
// MainnetGuardrailError → the script exits non-zero having sent nothing.

// Mainnet C-Chain facts. Hardcoded constants (not env) so a guardrail can't be
// loosened by a stray variable.
export const AVALANCHE_CHAIN_ID = 43114;
// Circle-issued mainnet USDC (6 decimals) — the ONLY token the mainnet converter
// wraps. deploy-mainnet never deploys a TestUSDC.
export const AVALANCHE_USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
// Circle-issued mainnet EURC (6 decimals).
export const AVALANCHE_EURC = "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD";
// Circle CCTP V2 on the C-Chain — the CCTP router's constructor takes the
// MessageTransmitterV2; TokenMessengerV2 is used by the settlement path.
export const AVALANCHE_CCTP_MESSAGE_TRANSMITTER =
	"0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
export const AVALANCHE_CCTP_TOKEN_MESSENGER =
	"0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

// Minimum AVAX the deployer must hold before a mainnet deploy is allowed.
export const MIN_DEPLOYER_BALANCE_WEI = 2n * 10n ** 18n; // 2 AVAX

export type MainnetGuardrailCode =
	| "confirm_flag_missing"
	| "wrong_network"
	| "wrong_chain_id"
	| "wrapped_token_deploy_test"
	| "wrapped_token_not_existing"
	| "ceremony_build_required"
	| "deployer_key_missing"
	| "auditor_key_missing"
	| "deployer_equals_auditor"
	| "insufficient_deployer_balance"
	| "auditor_key_not_provided";

export class MainnetGuardrailError extends Error {
	readonly code: MainnetGuardrailCode;
	constructor(code: MainnetGuardrailCode, message: string) {
		super(message);
		this.name = "MainnetGuardrailError";
		this.code = code;
	}
}

export type WrappedTokenLike = {
	mode: string;
	symbol: string;
	address?: string;
};

export type MainnetGuardrailInput = {
	// process.env.MAINNET_CONFIRM — the explicit human opt-in.
	confirm: string | undefined;
	// hardhat network.name — must be "avalanche".
	networkName: string;
	// chainId read from the RPC — must be 43114.
	chainId: number;
	// resolved NetworkDeployConfig.wrappedTokens for the network.
	wrappedTokens: ReadonlyArray<WrappedTokenLike>;
	// PRIVATE_KEY (deployer) / PRIVATE_KEY_2 (auditor signer).
	deployerPrivateKey: string | undefined;
	auditorPrivateKey: string | undefined;
	deployerBalanceWei: bigint;
	minDeployerBalanceWei: bigint;
	// Result of validating the #121 ceremony marker against the on-disk verifiers.
	ceremony: CeremonyValidation;
	// True only when the mainnet auditor BabyJubJub key is operator-provided
	// (sealed into the prod store); never auto-generated.
	auditorProvided: boolean;
};

const normalizeKey = (key: string): string => key.trim().toLowerCase();

// Throws on the FIRST failed guardrail. Order matters: the confirm flag is
// checked before anything else so an accidental invocation aborts before any RPC
// read the caller performed is even relevant.
export function assertMainnetGuardrails(input: MainnetGuardrailInput): void {
	if (input.confirm !== "1") {
		throw new MainnetGuardrailError(
			"confirm_flag_missing",
			"MAINNET_CONFIRM=1 is required to deploy to Avalanche mainnet; refusing.",
		);
	}

	if (input.networkName !== "avalanche") {
		throw new MainnetGuardrailError(
			"wrong_network",
			`deploy:mainnet must run with --network avalanche; got "${input.networkName}".`,
		);
	}

	if (input.chainId !== AVALANCHE_CHAIN_ID) {
		throw new MainnetGuardrailError(
			"wrong_chain_id",
			`RPC chainId must be ${AVALANCHE_CHAIN_ID} (C-Chain); got ${input.chainId}.`,
		);
	}

	if (input.wrappedTokens.some((token) => token.mode === "deploy-test")) {
		throw new MainnetGuardrailError(
			"wrapped_token_deploy_test",
			"mainnet must not deploy a TestUSDC — every wrapped token must be mode 'existing'.",
		);
	}

	const usdc = input.wrappedTokens.find(
		(token) => token.symbol.toUpperCase() === "USDC",
	);
	if (
		usdc === undefined ||
		usdc.mode !== "existing" ||
		usdc.address === undefined ||
		usdc.address.toLowerCase() !== AVALANCHE_USDC.toLowerCase()
	) {
		throw new MainnetGuardrailError(
			"wrapped_token_not_existing",
			`mainnet USDC must be wrapped as an existing token at ${AVALANCHE_USDC}.`,
		);
	}

	if (!input.ceremony.ok) {
		throw new MainnetGuardrailError(
			"ceremony_build_required",
			`verifiers are not a production ceremony build: ${input.ceremony.reason}`,
		);
	}

	if (!input.deployerPrivateKey) {
		throw new MainnetGuardrailError(
			"deployer_key_missing",
			"PRIVATE_KEY (deployer) is required.",
		);
	}

	if (!input.auditorPrivateKey) {
		throw new MainnetGuardrailError(
			"auditor_key_missing",
			"PRIVATE_KEY_2 (auditor signer) is required and must differ from the deployer.",
		);
	}

	if (
		normalizeKey(input.deployerPrivateKey) ===
		normalizeKey(input.auditorPrivateKey)
	) {
		throw new MainnetGuardrailError(
			"deployer_equals_auditor",
			"PRIVATE_KEY (deployer) and PRIVATE_KEY_2 (auditor) must be different keys.",
		);
	}

	if (input.deployerBalanceWei < input.minDeployerBalanceWei) {
		throw new MainnetGuardrailError(
			"insufficient_deployer_balance",
			`deployer AVAX balance ${input.deployerBalanceWei} is below the ${input.minDeployerBalanceWei} wei floor.`,
		);
	}

	if (!input.auditorProvided) {
		throw new MainnetGuardrailError(
			"auditor_key_not_provided",
			"mainnet auditor BabyJubJub public key must be operator-provided (MAINNET_AUDITOR_PUBKEY) with its private half sealed in the prod store; deploy will not auto-generate it.",
		);
	}
}
