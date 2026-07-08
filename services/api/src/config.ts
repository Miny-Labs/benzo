import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	ATTESTATION_API_BASE_BY_TIER,
	CHAIN_ENVS,
	CHAIN_ID_BY_ENV,
	deriveChainEnv,
	isLocalDatabaseUrl,
	isTestnetChainId,
	isTestnetRpcHost,
	loadDeploymentRegistry,
	NETWORK_TIER,
	resolveRpcUrl,
} from "./deployment-manifest.js";

const hex32BytesPattern = /^(?:0x)?[0-9a-fA-F]{64}$/;
const privateKeyPattern = /^0x[0-9a-fA-F]{64}$/;
const weiPattern = /^(0|[1-9][0-9]*)$/;
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const defaultPayrollZkArtifactDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../zk-artifacts",
);
const defaultDripWei = "500000000000000000";
export const DEFAULT_CORS_ORIGINS = [
	"https://wallet.benzo.space",
	"https://console.benzo.space",
	"http://localhost:5173",
	"http://localhost:5175",
];

const envSchema = z
	.object({
		APP_MASTER_KEY: z
			.string()
			.regex(hex32BytesPattern, "APP_MASTER_KEY must be a 32-byte hex string")
			.transform((value) => value.replace(/^0x/i, "").toLowerCase()),
		API_DOMAIN: z.string().trim().min(1).optional(),
		BENZONET_CHAIN_ID: z.coerce.number().int().positive().default(43_113),
		// Optional: resolves to a per-network default (fuji/avalanche) or is
		// required explicitly (benzonet). Never silently defaults to Fuji.
		BENZONET_RPC_URL: z.url().optional(),
		CHAIN_ENV: z.enum(CHAIN_ENVS).optional(),
		CORS_ORIGINS: z
			.string()
			.trim()
			.optional()
			.transform((value) => {
				if (value === undefined) {
					return [...DEFAULT_CORS_ORIGINS];
				}

				const parsed = Array.from(
					new Set(
						value
							.split(",")
							.map((origin) => origin.trim())
							.filter((origin) => origin.length > 0)
							// Normalize to a bare origin so copy-pasted URLs with a
							// trailing slash or path still match the request Origin header.
							.map((origin) => {
								try {
									return new URL(origin).origin;
								} catch {
									return origin;
								}
							}),
					),
				);

				// An explicitly empty/whitespace CORS_ORIGINS falls back to the
				// defaults rather than silently disabling all cross-origin access.
				return parsed.length > 0 ? parsed : [...DEFAULT_CORS_ORIGINS];
			}),
		DATABASE_URL: z.url(),
		CCTP_DEST_DOMAIN: z.coerce.number().int().default(1),
		DRIP_BALANCE_THRESHOLD_WEI: z
			.string()
			.regex(weiPattern, "DRIP_BALANCE_THRESHOLD_WEI must be a wei integer")
			.default(defaultDripWei),
		DRIP_WEI: z
			.string()
			.regex(weiPattern, "DRIP_WEI must be a wei integer")
			.default(defaultDripWei),
		EERC_DEPLOYMENT_MANIFEST: z.string().trim().min(1).optional(),
		// Optional ENV OVERRIDES only — when unset these resolve from the
		// deployment manifest for the resolved CHAIN_ENV (no Fuji fallback).
		EERC_ENCRYPTED_ERC_ADDRESS: z
			.string()
			.regex(evmAddressPattern, "EERC_ENCRYPTED_ERC_ADDRESS must be an EVM address")
			.optional(),
		EERC_REGISTRAR_ADDRESS: z
			.string()
			.regex(evmAddressPattern, "EERC_REGISTRAR_ADDRESS must be an EVM address")
			.optional(),
		HANDLE_REGISTRY_ADDRESS: z
			.string()
			.regex(evmAddressPattern, "HANDLE_REGISTRY_ADDRESS must be an EVM address")
			.optional(),
		HOST: z.string().default("0.0.0.0"),
		INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(6),
		INDEXER_ENABLED: z
			.enum(["true", "false"])
			.default("true")
			.transform((value) => value === "true"),
		INDEXER_MAX_WINDOW_BLOCKS: z.coerce.number().int().positive().default(2_000),
		INDEXER_POLL_CRON: z.string().trim().min(1).default("*/5 * * * * *"),
		INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
		KYC_PROVIDER: z.enum(["mock"]).default("mock"),
		LOG_LEVEL: z.string().default("info"),
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),
		OPS_PRIVATE_KEY: z
			.string()
			.regex(
				privateKeyPattern,
				"OPS_PRIVATE_KEY must be a 0x-prefixed private key",
			),
		ONBOARDING_REGISTRATION_POLL_SECONDS: z.coerce
			.number()
			.int()
			.positive()
			.default(15),
		PAYROLL_EERC_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
		// Optional ENV OVERRIDE only — resolves from the manifest USDC tokenId
		// when unset, falling back to 1n only if neither is available.
		PAYROLL_TOKEN_ID: z.coerce.bigint().nonnegative().optional(),
		PAYROLL_ZK_ARTIFACT_DIR: z
			.string()
			.trim()
			.min(1)
			.default(defaultPayrollZkArtifactDir),
		PORT: z.coerce.number().int().positive().default(3000),
		RELAYER_PRIVATE_KEY: z
			.string()
			.regex(
				privateKeyPattern,
				"RELAYER_PRIVATE_KEY must be a 0x-prefixed private key",
			),
		SESSION_COOKIE_NAME: z.string().min(1).default("benzo_session"),
		SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
		SIWE_NONCE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
	})
	.superRefine((env, ctx) => {
		const chainEnv = deriveChainEnv(env.CHAIN_ENV, env.BENZONET_CHAIN_ID);
		const tier = NETWORK_TIER[chainEnv];
		const expectedChainId = CHAIN_ID_BY_ENV[chainEnv];
		const rpcUrl = resolveRpcUrl(chainEnv, env.BENZONET_RPC_URL);

		if (env.NODE_ENV === "production" && !env.API_DOMAIN) {
			ctx.addIssue({
				code: "custom",
				message: "API_DOMAIN is required in production",
				path: ["API_DOMAIN"],
			});
		}

		if (env.CCTP_DEST_DOMAIN !== 1) {
			ctx.addIssue({
				code: "custom",
				message: `CCTP_DEST_DOMAIN must be 1, got ${env.CCTP_DEST_DOMAIN}`,
				path: ["CCTP_DEST_DOMAIN"],
			});
		}

		// CHAIN_ENV ⇄ chain id consistency. This also enforces
		// CHAIN_ENV=avalanche ⇒ chain id 43114 via CHAIN_ID_BY_ENV.
		if (env.BENZONET_CHAIN_ID !== expectedChainId) {
			ctx.addIssue({
				code: "custom",
				message: `BENZONET_CHAIN_ID must be ${expectedChainId} when CHAIN_ENV=${chainEnv}`,
				path: ["BENZONET_CHAIN_ID"],
			});
		}

		// benzonet has no default RPC — require it explicitly rather than
		// inheriting the Fuji endpoint.
		if (!rpcUrl) {
			ctx.addIssue({
				code: "custom",
				message: `BENZONET_RPC_URL is required for CHAIN_ENV=${chainEnv}`,
				path: ["BENZONET_RPC_URL"],
			});
		}

		// A deployed API must use a real database. This fires for NODE_ENV=production
		// on ANY tier (hardened staging on Fuji is legitimate) AND for the production
		// tier regardless of NODE_ENV — so a mainnet deploy that forgot to set
		// NODE_ENV=production can't slip a localhost database through.
		if (
			(env.NODE_ENV === "production" || tier === "production") &&
			isLocalDatabaseUrl(env.DATABASE_URL)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"DATABASE_URL must not point at a local database in a deployed (production) environment",
				path: ["DATABASE_URL"],
			});
		}

		// A production-tier (mainnet) network must be hardened and must never talk
		// to a testnet chain/RPC.
		if (tier === "production") {
			if (env.NODE_ENV !== "production") {
				ctx.addIssue({
					code: "custom",
					message: `production tier (CHAIN_ENV=${chainEnv}) requires NODE_ENV=production; got NODE_ENV=${env.NODE_ENV}`,
					path: ["NODE_ENV"],
				});
			}

			if (isTestnetChainId(env.BENZONET_CHAIN_ID)) {
				ctx.addIssue({
					code: "custom",
					message: `production tier (CHAIN_ENV=${chainEnv}) must not use a testnet chain id (${env.BENZONET_CHAIN_ID})`,
					path: ["BENZONET_CHAIN_ID"],
				});
			}

			if (rpcUrl && isTestnetRpcHost(rpcUrl)) {
				ctx.addIssue({
					code: "custom",
					message: `production tier (CHAIN_ENV=${chainEnv}) must not use a testnet RPC host (${rpcUrl})`,
					path: ["BENZONET_RPC_URL"],
				});
			}
		}
	})
	.transform((env) => {
		const chainEnv = deriveChainEnv(env.CHAIN_ENV, env.BENZONET_CHAIN_ID);
		const tier = NETWORK_TIER[chainEnv];
		const benzonetRpcUrl = resolveRpcUrl(chainEnv, env.BENZONET_RPC_URL);

		if (!benzonetRpcUrl) {
			// superRefine already flags this; guard again for type-narrowing.
			throw new Error(`BENZONET_RPC_URL is required for CHAIN_ENV=${chainEnv}`);
		}

		// Resolve the on-chain registry from the deployment manifest. A missing
		// or mismatched manifest throws here → fail fast at startup.
		const registry = loadDeploymentRegistry({
			chainEnv,
			chainId: env.BENZONET_CHAIN_ID,
			manifestPath: env.EERC_DEPLOYMENT_MANIFEST,
		});

		// Precedence: explicit ENV override → manifest → (hard error, no Fuji fallback).
		const eercEncryptedErcAddress =
			env.EERC_ENCRYPTED_ERC_ADDRESS?.toLowerCase() ??
			registry.encryptedErcAddress;

		if (!eercEncryptedErcAddress) {
			throw new Error(`eerc_encrypted_erc_unresolved:${chainEnv}`);
		}

		const eercRegistrarAddress =
			env.EERC_REGISTRAR_ADDRESS?.toLowerCase() ?? registry.registrarAddress;

		if (!eercRegistrarAddress) {
			throw new Error(`eerc_registrar_unresolved:${chainEnv}`);
		}

		const cctp = registry.cctp;

		return {
			appMasterKey: env.APP_MASTER_KEY,
			apiDomain: env.API_DOMAIN ?? `localhost:${env.PORT}`,
			autoDepositRouterAddress: cctp?.autoDepositRouter ?? null,
			benzonetChainId: env.BENZONET_CHAIN_ID,
			benzonetRpcUrl,
			cctpAttestationApiBase: ATTESTATION_API_BASE_BY_TIER[tier],
			cctpDestDomain: env.CCTP_DEST_DOMAIN,
			cctpDomain: cctp?.domain ?? null,
			cctpMessageTransmitter: cctp?.messageTransmitter ?? null,
			cctpTokenMessenger: cctp?.tokenMessenger ?? null,
			chainEnv,
			corsOrigins: env.CORS_ORIGINS,
			databaseUrl: env.DATABASE_URL,
			dripBalanceThresholdWei: BigInt(env.DRIP_BALANCE_THRESHOLD_WEI),
			dripWei: BigInt(env.DRIP_WEI),
			eercDeploymentManifest: env.EERC_DEPLOYMENT_MANIFEST,
			eercEncryptedErcAddress,
			eercRegistrarAddress,
			handleRegistryAddress:
				env.HANDLE_REGISTRY_ADDRESS?.toLowerCase() ??
				registry.handleRegistryAddress ??
				undefined,
			host: env.HOST,
			indexerConfirmations: env.INDEXER_CONFIRMATIONS,
			indexerEnabled: env.INDEXER_ENABLED,
			indexerMaxWindowBlocks: env.INDEXER_MAX_WINDOW_BLOCKS,
			indexerPollCron: env.INDEXER_POLL_CRON,
			indexerStartBlock: BigInt(env.INDEXER_START_BLOCK),
			kycProvider: env.KYC_PROVIDER,
			logLevel: env.LOG_LEVEL,
			nodeEnv: env.NODE_ENV,
			onboardingRegistrationPollSeconds:
				env.ONBOARDING_REGISTRATION_POLL_SECONDS,
			opsPrivateKey: env.OPS_PRIVATE_KEY,
			payrollEercDecimals: env.PAYROLL_EERC_DECIMALS,
			payrollTokenId:
				env.PAYROLL_TOKEN_ID ?? registry.tokens.USDC?.tokenId ?? 1n,
			payrollZkArtifactDir: path.resolve(env.PAYROLL_ZK_ARTIFACT_DIR),
			port: env.PORT,
			relayerPrivateKey: env.RELAYER_PRIVATE_KEY,
			sessionCookieName: env.SESSION_COOKIE_NAME,
			sessionTtlDays: env.SESSION_TTL_DAYS,
			siweNonceTtlMinutes: env.SIWE_NONCE_TTL_MINUTES,
			tier,
		};
	});

export type ApiConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	return envSchema.parse(env);
}
