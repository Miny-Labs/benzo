import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
	type FastifyBaseLogger,
	type FastifyServerOptions,
} from "fastify";
import { createPublicClient, http } from "viem";
import { loadConfig, type ApiConfig } from "./config.js";
import { createDb, createPool, type Database } from "./db/client.js";
import {
	createAdminChainClient,
	type AdminChainClient,
} from "./admin/chain.js";
import {
	createInMemoryIdentityChainClient,
	isInMemoryIdentityChainClient,
	type IdentityChainClient,
} from "./identity/chain.js";
import {
	createNoopOnboardingOrchestrator,
	type OnboardingOrchestrator,
} from "./identity/onboarding.js";
import {
	createViemChainLogSource,
	type ChainLogSource,
} from "./indexer/chain.js";
import { createBoss, registerJobs } from "./jobs/index.js";
import {
	createOnboardingChainClient,
	type OnboardingChainClient,
} from "./onboarding/chain.js";
import { createKycProvider, type KycProvider } from "./onboarding/kyc.js";
import authPlugin from "./plugins/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { activityRoutes } from "./routes/activity.js";
import { auditorRoutes } from "./routes/auditor.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { identityRoutes } from "./routes/identity.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { orgsRoutes } from "./routes/orgs.js";
import { payrollRoutes } from "./routes/payroll.js";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import {
	createViemPayrollSubmitter,
	createViemTreasuryRegistrar,
	type PayrollSubmitter,
	type TreasuryRegistrar,
} from "./payroll/chain.js";
import {
	createSnarkjsPayrollProver,
	type PayrollProver,
} from "./payroll/prover.js";

export type BuildAppOptions = {
	adminChain?: AdminChainClient;
	boss?: PgBoss;
	chain?: ChainLogSource;
	config?: ApiConfig;
	db?: Database;
	identityChain?: IdentityChainClient;
	kycProvider?: KycProvider;
	logger?: FastifyServerOptions["logger"];
	onboarding?: OnboardingOrchestrator;
	onboardingChain?: OnboardingChainClient;
	payrollProver?: PayrollProver;
	payrollSubmitter?: PayrollSubmitter;
	pool?: Pool;
	startBoss?: boolean;
	treasuryRegistrar?: TreasuryRegistrar;
};

export async function buildApp(options: BuildAppOptions = {}) {
	const config = options.config ?? loadConfig();
	const identityChain =
		options.identityChain ?? createInMemoryIdentityChainClient();

	assertIdentityChainConfigured(config, identityChain);

	const fastify = Fastify({
		genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID(),
		logger: options.logger ?? {
			level: config.logLevel,
		},
	});
	fastify.log.info(
		{
			chainId: config.benzonetChainId,
			eercEncryptedErc: config.eercEncryptedErcAddress,
			network: config.chainEnv,
			tier: config.tier,
		},
		"benzo api config resolved",
	);
	const pool = options.pool ?? createPool(config, fastify.log);
	const db = options.db ?? createDb(pool);
	const boss = options.boss ?? createBoss(config);
	const corsOrigins = new Set(config.corsOrigins);
	const onboarding =
		options.onboarding ?? createNoopOnboardingOrchestrator();
	const ownsBoss = !options.boss;
	const ownsPool = !options.pool;
	const publicClient = createPublicClient({
		transport: http(config.benzonetRpcUrl),
	});
	const onboardingChain =
		options.onboardingChain ??
		createOnboardingChainClient(config, publicClient);
	const kycProvider = options.kycProvider ?? createKycProvider(config);
	const chain = options.chain ?? createViemChainLogSource(publicClient);
	const adminChain =
		options.adminChain ?? createAdminChainClient(config, publicClient);
	const payrollProver =
		options.payrollProver ?? createSnarkjsPayrollProver(config);
	const payrollSubmitter =
		options.payrollSubmitter ??
		createViemPayrollSubmitter(config, publicClient);
	const treasuryRegistrar =
		options.treasuryRegistrar ??
		createViemTreasuryRegistrar(config, publicClient, payrollProver);
	let bossStarted = false;

	fastify.addHook("onClose", async () => {
		if (bossStarted && ownsBoss) {
			await boss.stop();
		}

		if (ownsPool) {
			await pool.end();
		}
	});

	try {
		fastify.addHook("onRequest", async (request, reply) => {
			reply.header("x-request-id", request.id);
		});

		fastify.setErrorHandler(async (error, request, reply) => {
			request.log.error({ err: error }, "request failed");
			await reply.code(500).send({ error: "internal_server_error" });
		});

		await fastify.register(cors, {
			credentials: true,
			origin: (origin, callback) => {
				if (!origin || !corsOrigins.has(origin)) {
					callback(null, false);
					return;
				}

				callback(null, origin);
			},
		});
		await fastify.register(cookie);
		await fastify.register(rateLimit, { global: false });
		await fastify.register(authPlugin, { config, db });
		await fastify.register(healthRoutes, { db, publicClient });
		await fastify.register(authRoutes, { config, db, publicClient });
		await fastify.register(onboardingRoutes, { boss, config, db });
		await fastify.register(identityRoutes, { db, identityChain, onboarding });
		await fastify.register(activityRoutes, { db });
		await fastify.register(auditorRoutes, { config, db });
		await fastify.register(adminRoutes, { adminChain, chain, config, db });
		await fastify.register(orgsRoutes, {
			config,
			db,
			onboardingChain,
			treasuryRegistrar,
		});
		await fastify.register(payrollRoutes, { boss, db });

		if (options.startBoss !== false) {
			await boss.start();
			bossStarted = true;
			await registerJobs(
				boss,
				db,
				fastify.log as FastifyBaseLogger,
				{
					chain: onboardingChain,
					config,
					kycProvider,
				},
				{
					chain,
					config,
				},
				{
					config,
					pool,
					prover: payrollProver,
					submitter: payrollSubmitter,
				},
			);
		}
	} catch (error) {
		await fastify.close().catch((closeError: unknown) => {
			fastify.log.error({ err: closeError }, "api startup cleanup failed");
		});
		throw error;
	}

	return fastify;
}

function assertIdentityChainConfigured(
	config: ApiConfig,
	identityChain: IdentityChainClient,
): void {
	if (config.nodeEnv === "test") {
		return;
	}

	if (isInMemoryIdentityChainClient(identityChain)) {
		throw new Error(
			"Identity chain client is not configured. Provide a real identity chain client outside NODE_ENV=test.",
		);
	}
}
