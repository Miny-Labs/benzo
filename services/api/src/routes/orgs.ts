import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { ApiConfig, TreasuryFundingToken } from "../config.js";
import type { Database } from "../db/client.js";
import { sealString, unsealString } from "../crypto/seal.js";
import {
	orgMembers,
	orgTreasuries,
	orgs,
	treasuryDeposits,
} from "../db/schema.js";
import {
	ROLE_RANK,
	loadMembership,
	makeRequireOrgRole,
} from "../orgs/access.js";
import type { OnboardingChainClient } from "../onboarding/chain.js";
import {
	createManagedEercAccount,
	deserializeManagedEercAccount,
	encryptAmountPct,
	getDecryptedBalance,
	serializeManagedEercAccount,
	type ManagedEercAccount,
} from "../payroll/eerc.js";
import type {
	PayrollSubmitter,
	TreasuryDepositSubmissionResult,
	TreasuryRegistrar,
} from "../payroll/chain.js";

type OrgsRoutesOptions = {
	config: ApiConfig;
	db: Database;
	onboardingChain: OnboardingChainClient;
	payrollSubmitter: PayrollSubmitter;
	treasuryRegistrar: TreasuryRegistrar;
};

const createOrgSchema = z.object({
	name: z.string().trim().min(1).max(120),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(60)
		.regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric or hyphen"),
});

const addMemberSchema = z.object({
	address: z.string().trim().toLowerCase(),
	role: z.enum(["admin", "operator", "viewer"]),
});

const provisionTreasurySchema = z.object({
	// Managed-treasury custody is an explicit consent moment: the caller must
	// acknowledge that Benzo will hold this treasury key on its servers.
	consent: z.literal(true),
});

const treasuryDepositSchema = z.object({
	amount: z.string().trim().regex(/^[1-9][0-9]*$/),
	// Optional dedupe token: a retry carrying a previously seen key returns the
	// original deposit instead of broadcasting a second approve/deposit.
	idempotencyKey: z.string().trim().min(1).max(255).optional(),
	token: z.enum(["usdc", "eurc"]),
});

const evmAddress = /^0x[0-9a-fA-F]{40}$/;

export const orgsRoutes: FastifyPluginAsync<OrgsRoutesOptions> = async (
	fastify,
	options,
) => {
	const { db } = options;
	const requireOrgRole = makeRequireOrgRole(fastify, db);

	// POST /orgs — create an org; the creator becomes its owner.
	fastify.post(
		"/orgs",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const body = createOrgSchema.safeParse(request.body);
			if (!body.success) {
				return reply.code(400).send({ error: "invalid_org" });
			}

			const userId = request.user!.id;
			const created = await db.transaction(async (tx) => {
				// ON CONFLICT DO NOTHING on the unique slug: a taken slug (or a race
				// between two creators) returns no row and maps to 409 below, instead
				// of the raw 23505 escaping the transaction as a 500.
				const [org] = await tx
					.insert(orgs)
					.values({ name: body.data.name, slug: body.data.slug })
					.onConflictDoNothing({ target: orgs.slug })
					.returning();
				if (!org) {
					return null;
				}
				await tx
					.insert(orgMembers)
					.values({ orgId: org.id, userId, role: "owner" });
				return org;
			});

			if (!created) {
				return reply.code(409).send({ error: "slug_taken" });
			}

			return reply.code(201).send({ org: created, role: "owner" });
		},
	);

	// GET /orgs — orgs the caller belongs to, with their role in each.
	fastify.get(
		"/orgs",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const userId = request.user!.id;
			const rows = await db
				.select({
					id: orgs.id,
					name: orgs.name,
					slug: orgs.slug,
					role: orgMembers.role,
					createdAt: orgs.createdAt,
				})
				.from(orgMembers)
				.innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
				.where(eq(orgMembers.userId, userId));
			return reply.send({ orgs: rows });
		},
	);

	// GET /orgs/:id — org detail; any member may read.
	fastify.get(
		"/orgs/:id",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const [org] = await db
				.select()
				.from(orgs)
				.where(eq(orgs.id, orgId))
				.limit(1);
			return reply.send({ org, role: request.orgRole });
		},
	);

	// GET /orgs/:id/members — any member may list.
	fastify.get(
		"/orgs/:id/members",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const members = await db
				.select({
					userId: orgMembers.userId,
					role: orgMembers.role,
					createdAt: orgMembers.createdAt,
				})
				.from(orgMembers)
				.where(eq(orgMembers.orgId, orgId));
			return reply.send({ members });
		},
	);

	// POST /orgs/:id/members — add/update a member by wallet address (admin+).
	fastify.post(
		"/orgs/:id/members",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const body = addMemberSchema.safeParse(request.body);
			if (!body.success || !evmAddress.test(body.data.address)) {
				return reply.code(400).send({ error: "invalid_member" });
			}

			// The member must already be a known user (they sign in via SIWE first).
			const user = await db.query.users.findFirst({
				where: (u, { eq: eqOp }) => eqOp(u.address, body.data.address),
			});
			if (!user) {
				return reply.code(404).send({ error: "user_not_found" });
			}

			// A caller may not modify a member whose current role outranks or
			// equals their own — otherwise an admin could demote the owner (whom
			// they can never restore, since "owner" isn't a settable role). This
			// also blocks demoting/self-editing at the same rank.
			const existingRole = await loadMembership(db, orgId, user.id);
			const callerRole = request.orgRole!;
			if (
				existingRole !== null &&
				ROLE_RANK[existingRole] >= ROLE_RANK[callerRole]
			) {
				return reply.code(403).send({ error: "forbidden" });
			}

			await db
				.insert(orgMembers)
				.values({ orgId, userId: user.id, role: body.data.role })
				.onConflictDoUpdate({
					target: [orgMembers.orgId, orgMembers.userId],
					set: { role: body.data.role },
				});

			return reply.code(201).send({ userId: user.id, role: body.data.role });
		},
	);

	// POST /orgs/:id/treasury — provision the managed treasury (owner/admin).
	// Generates an EOA, records custody consent, onboards the address, registers
	// it with eERC, and seals both server-held keys under APP_MASTER_KEY.
	fastify.post(
		"/orgs/:id/treasury",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const body = provisionTreasurySchema.safeParse(request.body);
			if (!body.success) {
				return reply.code(400).send({ error: "consent_required" });
			}

			let createdTreasury = false;
			let treasury = await db.query.orgTreasuries.findFirst({
				where: (table, { eq: eqOp }) => eqOp(table.orgId, orgId),
			});

			if (treasury?.eercRegisteredAt) {
				return reply.code(409).send({ error: "treasury_exists" });
			}

			if (!treasury) {
				const privateKey = generatePrivateKey();
				const account = privateKeyToAccount(privateKey);
				const sealedEoaKey = sealString(
					options.config.appMasterKey,
					privateKey,
				);

				// Atomic: the unique index on org_id makes this race-safe. A second
				// concurrent request conflicts and returns no row (409) instead of
				// throwing on the constraint; the losing request's generated key was
				// never persisted, so nothing leaks.
				const [inserted] = await db
					.insert(orgTreasuries)
					.values({
						address: account.address.toLowerCase(),
						consentedAt: new Date(),
						consentedBy: request.user!.id,
						orgId,
						sealedEoaKey,
					})
					.onConflictDoNothing({ target: orgTreasuries.orgId })
					.returning();

				if (!inserted) {
					return reply.code(409).send({ error: "treasury_exists" });
				}

				createdTreasury = true;
				treasury = inserted;
			}

			const eoaPrivateKey = unsealString(
				options.config.appMasterKey,
				treasury.sealedEoaKey,
			) as `0x${string}`;
			const eercAccount = await loadOrCreateTreasuryEercAccount(
				db,
				options.config,
				treasury.id,
				treasury.sealedEercKey,
			);

			await options.onboardingChain.ensureAllowlisted(treasury.address);
			const balance = await options.onboardingChain.getNativeBalance(
				treasury.address,
			);
			if (balance < options.config.dripBalanceThresholdWei) {
				await options.onboardingChain.dripGas(
					treasury.address,
					options.config.dripWei,
				);
			}

			const registration = await options.treasuryRegistrar.registerTreasury({
				address: treasury.address,
				eercAccount,
				eoaPrivateKey,
			});
			// Persist the consent moment on every registration path. The insert
			// branch already stamps consent, but an existing (pre-consent) treasury
			// row reaching this point consented via this request's `consent: true`
			// body — record it without clobbering an earlier timestamp.
			await db
				.update(orgTreasuries)
				.set({
					consentedAt: treasury.consentedAt ?? new Date(),
					consentedBy: treasury.consentedBy ?? request.user!.id,
					eercRegisteredAt: new Date(),
				})
				.where(eq(orgTreasuries.id, treasury.id));

			return reply.code(createdTreasury ? 201 : 200).send({
				address: getAddress(treasury.address),
				custody: "managed",
				consented: true,
				registered: true,
				registrationTxHash: registration.txHash,
			});
		},
	);

	// POST /orgs/:id/treasury/deposit — convert ERC20 into encrypted treasury
	// balance. The managed EOA key is unsealed only for signing approve/deposit.
	fastify.post(
		"/orgs/:id/treasury/deposit",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const body = treasuryDepositSchema.safeParse(request.body);
			if (!body.success) {
				return reply.code(400).send({ error: "invalid_treasury_deposit" });
			}

			const token = resolveFundingToken(options.config, body.data.token);
			if (!token) {
				return reply.code(503).send({ error: "treasury_token_not_configured" });
			}

			const treasury = await db.query.orgTreasuries.findFirst({
				where: (table, { eq: eqOp }) => eqOp(table.orgId, orgId),
			});
			if (!treasury) {
				return reply.code(404).send({ error: "treasury_not_found" });
			}
			if (!treasury.eercRegisteredAt || !treasury.sealedEercKey) {
				return reply
					.code(409)
					.send({ error: "treasury_not_eerc_registered" });
			}

			const amount = BigInt(body.data.amount);
			const idempotencyKey = body.data.idempotencyKey ?? null;

			// Idempotency: a retry reusing a key we've already recorded for this org
			// returns the original record instead of broadcasting a second deposit.
			if (idempotencyKey) {
				const existing = await db.query.treasuryDeposits.findFirst({
					where: (table, { and: andOp, eq: eqOp }) =>
						andOp(
							eqOp(table.orgId, orgId),
							eqOp(table.idempotencyKey, idempotencyKey),
						),
				});
				if (existing) {
					return reply.code(200).send({
						amount: existing.amount,
						source: existing.source,
						status: existing.status,
						token: existing.token,
						tokenId: existing.tokenId.toString(),
						txHash: existing.txHash,
					});
				}
			}

			const eoaPrivateKey = unsealString(
				options.config.appMasterKey,
				treasury.sealedEoaKey,
			) as `0x${string}`;
			const eercAccount = deserializeManagedEercAccount(
				unsealString(options.config.appMasterKey, treasury.sealedEercKey),
			);

			// Durably record intent BEFORE the irreversible approve/deposit. If the
			// process dies after the tx confirms, this `submitted` row survives so a
			// keyed retry short-circuits above rather than double-funding.
			const [pending] = await db
				.insert(treasuryDeposits)
				.values({
					amount: amount.toString(),
					idempotencyKey,
					orgId,
					source: "direct",
					status: "submitted",
					token: token.token,
					tokenId: token.tokenId,
				})
				.returning({ id: treasuryDeposits.id });

			let result: TreasuryDepositSubmissionResult;
			try {
				result = await options.payrollSubmitter.submitTreasuryDeposit({
					amount,
					amountPCT: encryptAmountPct(amount, eercAccount.publicKey),
					confirmations: options.config.indexerConfirmations,
					eoaPrivateKey,
					tokenAddress: token.address,
				});
			} catch (error) {
				await db
					.update(treasuryDeposits)
					.set({ status: "failed", updatedAt: new Date() })
					.where(eq(treasuryDeposits.id, pending!.id));
				request.log.error(
					{ err: error, orgId },
					"treasury_deposit_submit_failed",
				);
				return reply.code(502).send({ error: "treasury_deposit_failed" });
			}

			await db
				.update(treasuryDeposits)
				.set({
					status: "confirmed",
					txHash: result.txHash.toLowerCase(),
					updatedAt: new Date(),
				})
				.where(eq(treasuryDeposits.id, pending!.id));

			return reply.code(201).send({
				amount: amount.toString(),
				approvalTxHash: result.approvalTxHash,
				source: "direct",
				status: "confirmed",
				token: token.token,
				tokenId: token.tokenId.toString(),
				txHash: result.txHash,
			});
		},
	);

	// GET /orgs/:id/treasury — custody status; never returns key material.
	fastify.get(
		"/orgs/:id/treasury",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			// Push the "registered" boolean into the query so status reads don't
			// need any key material.
			const [treasury] = await db
				.select({
					address: orgTreasuries.address,
					consentedAt: orgTreasuries.consentedAt,
					consentedBy: orgTreasuries.consentedBy,
					eercRegisteredAt: orgTreasuries.eercRegisteredAt,
					sealedEercKey: orgTreasuries.sealedEercKey,
				})
				.from(orgTreasuries)
				.where(eq(orgTreasuries.orgId, orgId))
				.limit(1);

			if (!treasury) {
				return reply.code(404).send({ error: "treasury_not_found" });
			}

			const registered = treasury.eercRegisteredAt !== null;
			const balances =
				registered && treasury.sealedEercKey
					? await loadTreasuryBalances({
							config: options.config,
							eercKey: treasury.sealedEercKey,
							submitter: options.payrollSubmitter,
							treasuryAddress: treasury.address,
						})
					: [];

			return reply.send({
				address: getAddress(treasury.address),
				balances,
				custody: "managed",
				custodyConsent: {
					consented: treasury.consentedAt !== null,
					consentedAt: treasury.consentedAt?.toISOString() ?? null,
					consentedBy: treasury.consentedBy,
				},
				consented: treasury.consentedAt !== null,
				registered,
			});
		},
	);
};

function resolveFundingToken(
	config: ApiConfig,
	token: "usdc" | "eurc",
): TreasuryFundingToken | null {
	return (
		config.treasuryFundingTokens.find(
			(entry) => entry.token === token,
		) ?? null
	);
}

async function loadTreasuryBalances({
	config,
	eercKey,
	submitter,
	treasuryAddress,
}: {
	config: ApiConfig;
	eercKey: Buffer;
	submitter: PayrollSubmitter;
	treasuryAddress: string;
}) {
	const account = deserializeManagedEercAccount(
		unsealString(config.appMasterKey, eercKey),
	);

	return Promise.all(
		config.treasuryFundingTokens.map(async (token) => {
			const balance = await submitter.loadTreasuryBalance({
				tokenId: token.tokenId,
				treasuryAddress,
			});

			return {
				amount: getDecryptedBalance(account.privateKey, balance).toString(),
				decimals: token.decimals,
				symbol: token.symbol,
				token: token.token,
				tokenId: token.tokenId.toString(),
			};
		}),
	);
}

async function loadOrCreateTreasuryEercAccount(
	db: Database,
	config: ApiConfig,
	treasuryId: string,
	sealedEercKey: Buffer | null,
): Promise<ManagedEercAccount> {
	if (sealedEercKey) {
		return deserializeManagedEercAccount(
			unsealString(config.appMasterKey, sealedEercKey),
		);
	}

	const account = createManagedEercAccount();
	const sealed = sealString(
		config.appMasterKey,
		serializeManagedEercAccount(account),
	);
	const [updated] = await db
		.update(orgTreasuries)
		.set({ sealedEercKey: sealed })
		.where(
			and(
				eq(orgTreasuries.id, treasuryId),
				isNull(orgTreasuries.sealedEercKey),
			),
		)
		.returning({ sealedEercKey: orgTreasuries.sealedEercKey });

	if (updated?.sealedEercKey) {
		return account;
	}

	const [existing] = await db
		.select({ sealedEercKey: orgTreasuries.sealedEercKey })
		.from(orgTreasuries)
		.where(eq(orgTreasuries.id, treasuryId))
		.limit(1);
	if (!existing?.sealedEercKey) {
		throw new Error("treasury_eerc_key_not_persisted");
	}

	return deserializeManagedEercAccount(
		unsealString(config.appMasterKey, existing.sealedEercKey),
	);
}
