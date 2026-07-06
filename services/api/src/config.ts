import { z } from "zod";

const hex32BytesPattern = /^(?:0x)?[0-9a-fA-F]{64}$/;
const privateKeyPattern = /^0x[0-9a-fA-F]{64}$/;

const envSchema = z
	.object({
		APP_MASTER_KEY: z
			.string()
			.regex(hex32BytesPattern, "APP_MASTER_KEY must be a 32-byte hex string")
			.transform((value) => value.replace(/^0x/i, "").toLowerCase()),
		API_DOMAIN: z.string().trim().min(1).optional(),
		BENZONET_CHAIN_ID: z.coerce.number().int().positive().default(43_113),
		BENZONET_RPC_URL: z.url(),
		DATABASE_URL: z.url(),
		HOST: z.string().default("0.0.0.0"),
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
	})
	.transform((env) => ({
		appMasterKey: env.APP_MASTER_KEY,
		apiDomain: env.API_DOMAIN ?? `localhost:${env.PORT}`,
		benzonetChainId: env.BENZONET_CHAIN_ID,
		benzonetRpcUrl: env.BENZONET_RPC_URL,
		databaseUrl: env.DATABASE_URL,
		host: env.HOST,
		logLevel: env.LOG_LEVEL,
		nodeEnv: env.NODE_ENV,
		opsPrivateKey: env.OPS_PRIVATE_KEY,
		port: env.PORT,
		sessionCookieName: env.SESSION_COOKIE_NAME,
		sessionTtlDays: env.SESSION_TTL_DAYS,
		siweNonceTtlMinutes: env.SIWE_NONCE_TTL_MINUTES,
	}));

export type ApiConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	return envSchema.parse(env);
}
