import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const hex32BytesPattern = /^(?:0x)?[0-9a-fA-F]{64}$/;
const privateKeyPattern = /^0x[0-9a-fA-F]{64}$/;
const weiPattern = /^(0|[1-9][0-9]*)$/;
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const defaultPayrollZkArtifactDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../zk-artifacts",
);
const defaultDripWei = "500000000000000000";
const fujiChainId = 43_113;
const benzonetChainId = 68_420;
const fujiEncryptedErcAddress = "0x46688f1704a69a6c276cCCB823E36C80787B0FA2";
const fujiRegistrarAddress = "0x9a63FEa9851097DBAf3757b636217fdde50ABaF0";
const fujiRpcUrl = "https://api.avax-test.network/ext/bc/C/rpc";

const envSchema = z
	.object({
		APP_MASTER_KEY: z
			.string()
			.regex(hex32BytesPattern, "APP_MASTER_KEY must be a 32-byte hex string")
			.transform((value) => value.replace(/^0x/i, "").toLowerCase()),
		API_DOMAIN: z.string().trim().min(1).optional(),
		BENZONET_CHAIN_ID: z.coerce.number().int().positive().default(43_113),
		BENZONET_RPC_URL: z.url().default(fujiRpcUrl),
		CHAIN_ENV: z.enum(["fuji", "benzonet"]).optional(),
		DATABASE_URL: z.url(),
		DRIP_BALANCE_THRESHOLD_WEI: z
			.string()
			.regex(weiPattern, "DRIP_BALANCE_THRESHOLD_WEI must be a wei integer")
			.default(defaultDripWei),
		DRIP_WEI: z
			.string()
			.regex(weiPattern, "DRIP_WEI must be a wei integer")
			.default(defaultDripWei),
		EERC_DEPLOYMENT_MANIFEST: z.string().trim().min(1).optional(),
		EERC_ENCRYPTED_ERC_ADDRESS: z
			.string()
			.regex(evmAddressPattern, "EERC_ENCRYPTED_ERC_ADDRESS must be an EVM address")
			.default(fujiEncryptedErcAddress),
		EERC_REGISTRAR_ADDRESS: z
			.string()
			.regex(evmAddressPattern, "EERC_REGISTRAR_ADDRESS must be an EVM address")
			.default(fujiRegistrarAddress),
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
		PAYROLL_TOKEN_ID: z.coerce.bigint().nonnegative().default(1n),
		PAYROLL_ZK_ARTIFACT_DIR: z
			.string()
			.trim()
			.min(1)
			.default(defaultPayrollZkArtifactDir),
		PORT: z.coerce.number().int().positive().default(3000),
		SESSION_COOKIE_NAME: z.string().min(1).default("benzo_session"),
		SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
		SIWE_NONCE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
	})
	.superRefine((env, ctx) => {
		if (env.NODE_ENV === "production" && !env.API_DOMAIN) {
			ctx.addIssue({
				code: "custom",
				message: "API_DOMAIN is required in production",
				path: ["API_DOMAIN"],
			});
		}

		const chainEnv =
			env.CHAIN_ENV ?? (env.BENZONET_CHAIN_ID === fujiChainId ? "fuji" : "benzonet");
		const expectedChainId =
			chainEnv === "fuji" ? fujiChainId : benzonetChainId;

		if (env.BENZONET_CHAIN_ID !== expectedChainId) {
			ctx.addIssue({
				code: "custom",
				message: `BENZONET_CHAIN_ID must be ${expectedChainId} when CHAIN_ENV=${chainEnv}`,
				path: ["BENZONET_CHAIN_ID"],
			});
		}
	})
	.transform((env) => ({
		appMasterKey: env.APP_MASTER_KEY,
		apiDomain: env.API_DOMAIN ?? `localhost:${env.PORT}`,
		benzonetChainId: env.BENZONET_CHAIN_ID,
		benzonetRpcUrl: env.BENZONET_RPC_URL,
		chainEnv:
			env.CHAIN_ENV ?? (env.BENZONET_CHAIN_ID === fujiChainId ? "fuji" : "benzonet"),
		databaseUrl: env.DATABASE_URL,
		dripBalanceThresholdWei: BigInt(env.DRIP_BALANCE_THRESHOLD_WEI),
		dripWei: BigInt(env.DRIP_WEI),
		eercDeploymentManifest: env.EERC_DEPLOYMENT_MANIFEST,
		eercEncryptedErcAddress: env.EERC_ENCRYPTED_ERC_ADDRESS.toLowerCase(),
		eercRegistrarAddress: env.EERC_REGISTRAR_ADDRESS.toLowerCase(),
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
		payrollTokenId: env.PAYROLL_TOKEN_ID,
		payrollZkArtifactDir: path.resolve(env.PAYROLL_ZK_ARTIFACT_DIR),
		port: env.PORT,
		sessionCookieName: env.SESSION_COOKIE_NAME,
		sessionTtlDays: env.SESSION_TTL_DAYS,
		siweNonceTtlMinutes: env.SIWE_NONCE_TTL_MINUTES,
	}));

export type ApiConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	return envSchema.parse(env);
}
