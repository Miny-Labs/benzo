import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { getAddress, isAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type {
	AdminChainClient,
	AllowlistActionResult,
	AllowlistStatus,
} from "../admin/chain.js";
import type { ApiConfig, TreasuryFundingToken } from "../config.js";
import type { Database } from "../db/client.js";
import { sealString, unsealString } from "../crypto/seal.js";
import {
	auditLog,
	kycRecords,
	onboardings,
	orgMemberAllowlist,
	orgMembers,
	orgTreasuries,
	orgs,
	treasuryDeposits,
	users,
	type OnboardingStatus,
	type OrgMemberAllowlistStatus,
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
	adminChain: AdminChainClient;
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
	// Required dedupe token: a money-movement deposit must be safe to retry, so
	// callers always supply a key. A retry carrying a previously seen key returns
	// the original deposit instead of broadcasting a second approve/deposit.
	idempotencyKey: z.string().trim().min(1).max(255),
	token: z.enum(["usdc", "eurc"]),
});

const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const approvedKycOnboardingStatuses = new Set<OnboardingStatus>([
	"kyc_approved",
	"allowlisted",
	"gas_dripped",
	"awaiting_registration",
	"complete",
]);

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

	fastify.get(
		"/orgs/:id/members/:address/allowlist",
		{ preHandler: requireOrgRole("viewer") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const address = normalizeMemberAddress(
				(request.params as { address: string }).address,
			);
			if (!address) {
				return reply.code(400).send({ error: "invalid_member" });
			}

			const member = await loadOrgMemberAllowlist(options.db, orgId, address);
			if (!member) {
				return reply.code(404).send({ error: "member_not_found" });
			}

			const chain = await options.adminChain.getAllowlistStatus(member.address);

			return reply.send({
				allowlist: serializeMemberAllowlist(member, chain),
			});
		},
	);

	fastify.post(
		"/orgs/:id/members/:address/allowlist",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const address = normalizeMemberAddress(
				(request.params as { address: string }).address,
			);
			if (!address) {
				return reply.code(400).send({ error: "invalid_member" });
			}

			const member = await loadOrgMemberAllowlist(options.db, orgId, address);
			if (!member) {
				return reply.code(404).send({ error: "member_not_found" });
			}
			if (!member.kyc.approved) {
				return reply.code(409).send({
					error: "kyc_not_approved",
					kyc: member.kyc,
				});
			}

			const result = await options.adminChain.applyAllowlist(
				member.address,
				"enable",
			);
			const updatedMember = withAllowlistChange(member, "enabled", result);
			await recordMemberAllowlistChange({
				action: "enable",
				actor: request.user!.address,
				chainEnv: options.config.chainEnv,
				chainId: options.config.benzonetChainId,
				db: options.db,
				member,
				result,
			});

			return reply.send({
				allowlist: serializeMemberAllowlist(
					updatedMember,
					allowlistResultToStatus(result),
					result,
				),
			});
		},
	);

	fastify.delete(
		"/orgs/:id/members/:address/allowlist",
		{ preHandler: requireOrgRole("admin") },
		async (request, reply) => {
			const orgId = (request.params as { id: string }).id;
			const address = normalizeMemberAddress(
				(request.params as { address: string }).address,
			);
			if (!address) {
				return reply.code(400).send({ error: "invalid_member" });
			}

			const member = await loadOrgMemberAllowlist(options.db, orgId, address);
			if (!member) {
				return reply.code(404).send({ error: "member_not_found" });
			}

			const result = await options.adminChain.applyAllowlist(
				member.address,
				"revoke",
			);
			const updatedMember = withAllowlistChange(member, "revoked", result);
			await recordMemberAllowlistChange({
				action: "revoke",
				actor: request.user!.address,
				chainEnv: options.config.chainEnv,
				chainId: options.config.benzonetChainId,
				db: options.db,
				member,
				result,
			});

			return reply.send({
				allowlist: serializeMemberAllowlist(
					updatedMember,
					allowlistResultToStatus(result),
					result,
				),
			});
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
			const idempotencyKey = body.data.idempotencyKey;

			// Idempotency: a retry reusing a key we've already recorded for this org
			// returns the original record instead of broadcasting a second deposit.
			const existing = await db.query.treasuryDeposits.findFirst({
				where: (table, { and: andOp, eq: eqOp }) =>
					andOp(
						eqOp(table.orgId, orgId),
						eqOp(table.idempotencyKey, idempotencyKey),
					),
			});
			// An idempotency key is bound to its request: reusing it with a
			// different amount or token is a distinct funding action, not a retry,
			// and must be rejected rather than silently resolving to the original.
			if (
				existing &&
				(existing.amount !== amount.toString() ||
					existing.token !== token.token)
			) {
				return reply.code(409).send({ error: "idempotency_key_conflict" });
			}
			// A keyed retry is resumable (re-attempts the funding, re-claiming the
			// existing row) when either: (a) the previous attempt `failed` — a
			// reverted approve/deposit moved no funds, so retrying with the same key
			// is safe; or (b) it is `submitted` with no txHash and older than the
			// lease, meaning it crashed BEFORE broadcasting (sign-first guarantees a
			// null hash => not broadcast). A recent null-hash row is still in-flight
			// (202); a confirmed or hash-bearing submitted row is terminal.
			const TREASURY_DEPOSIT_LEASE_MS = 90_000;
			const resumable =
				existing != null &&
				(existing.status === "failed" ||
					(existing.status === "submitted" &&
						!existing.txHash &&
						Date.now() - existing.updatedAt.getTime() >
							TREASURY_DEPOSIT_LEASE_MS));
			if (existing && !resumable) {
				const inFlightPreBroadcast =
					existing.status === "submitted" && !existing.txHash;
				return reply.code(inFlightPreBroadcast ? 202 : 200).send({
					amount: existing.amount,
					source: existing.source,
					status: existing.status,
					token: existing.token,
					tokenId: existing.tokenId.toString(),
					txHash: existing.txHash,
				});
			}

			const eoaPrivateKey = unsealString(
				options.config.appMasterKey,
				treasury.sealedEoaKey,
			) as `0x${string}`;
			const eercAccount = deserializeManagedEercAccount(
				unsealString(options.config.appMasterKey, treasury.sealedEercKey),
			);

			// Durably record intent BEFORE the irreversible approve/deposit. On
			// resume, re-claim the row under a SELECT ... FOR UPDATE row lock so two
			// concurrent retries can't both broadcast. A row lock is used instead of
			// an updatedAt-equality guard because Postgres timestamptz precision does
			// not round-trip through a JS Date, so an equality guard would never match
			// and would strand every resume at 202.
			let pendingId: string;
			if (resumable && existing) {
				const claimedId = await db.transaction(async (tx) => {
					const [locked] = await tx
						.select()
						.from(treasuryDeposits)
						.where(eq(treasuryDeposits.id, existing.id))
						.for("update");
					const stillResumable =
						locked != null &&
						(locked.status === "failed" ||
							(locked.status === "submitted" &&
								!locked.txHash &&
								Date.now() - locked.updatedAt.getTime() >
									TREASURY_DEPOSIT_LEASE_MS));
					if (!stillResumable) {
						return null;
					}
					await tx
						.update(treasuryDeposits)
						.set({ status: "submitted", txHash: null, updatedAt: new Date() })
						.where(eq(treasuryDeposits.id, existing.id));
					return existing.id;
				});
				if (!claimedId) {
					// Another request claimed the resume, or it is no longer resumable.
					return reply.code(202).send({
						amount: existing.amount,
						source: existing.source,
						status: "submitted",
						token: existing.token,
						tokenId: existing.tokenId.toString(),
						txHash: null,
					});
				}
				pendingId = claimedId;
			} else {
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
				pendingId = pending!.id;
			}

			// Captured the moment the deposit tx is broadcast (before the
			// confirmation wait). Once set, the tx may have landed on-chain, so a
			// later failure must never mark the row `failed`.
			let broadcastTxHash: Hex | null = null;
			let result: TreasuryDepositSubmissionResult;
			try {
				result = await options.payrollSubmitter.submitTreasuryDeposit({
					amount,
					amountPCT: encryptAmountPct(amount, eercAccount.publicKey),
					confirmations: options.config.indexerConfirmations,
					eoaPrivateKey,
					onBeforeBroadcast: async (h) => {
						// Called AFTER signing, BEFORE sending. Persist the hash first,
						// then flag it: with sign-first, if this persist throws the tx is
						// never sent, so leaving broadcastTxHash null makes the catch mark
						// the row `failed` (correct — nothing was broadcast, safe to retry).
						await db
							.update(treasuryDeposits)
							.set({ txHash: h.toLowerCase(), updatedAt: new Date() })
							.where(eq(treasuryDeposits.id, pendingId));
						broadcastTxHash = h;
					},
					tokenAddress: token.address,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (message === "treasury_deposit_send_rejected") {
					// The signed tx was rejected by the node and never entered the mempool.
					// Clear the pre-persisted hash so the row is resumable (a keyed retry
					// re-signs and re-sends) rather than stranded `submitted` with a dead hash.
					await db
						.update(treasuryDeposits)
						.set({ status: "submitted", txHash: null, updatedAt: new Date() })
						.where(eq(treasuryDeposits.id, pendingId));
					request.log.warn({ err: error, orgId }, "treasury_deposit_send_rejected");
					return reply.code(202).send({
						amount: amount.toString(),
						source: "direct",
						status: "submitted",
						token: token.token,
						tokenId: token.tokenId.toString(),
						txHash: null,
					});
				}
				const reverted =
					message === "treasury_deposit_reverted" ||
					message === "treasury_deposit_approval_reverted";

				if (reverted) {
					// A confirmed on-chain revert is terminal — the funding did not happen,
					// so mark the row `failed` instead of leaving it `submitted` as if it
					// might still settle.
					await db
						.update(treasuryDeposits)
						.set({ status: "failed", updatedAt: new Date() })
						.where(eq(treasuryDeposits.id, pendingId));
					request.log.error(
						{ err: error, orgId, txHash: broadcastTxHash },
						"treasury_deposit_reverted",
					);
					return reply.code(502).send({ error: "treasury_deposit_reverted" });
				}

				if (broadcastTxHash) {
					// Deposit signed, hash persisted, and sent, but the confirmation wait
					// failed transiently; it may still settle. Leave `submitted` with the
					// hash so a reconciler can settle it and no money is lost.
					request.log.warn(
						{ err: error, orgId, txHash: broadcastTxHash },
						"treasury_deposit_broadcast_unconfirmed",
					);
					return reply.code(202).send({
						amount: amount.toString(),
						source: "direct",
						status: "submitted",
						token: token.token,
						tokenId: token.tokenId.toString(),
						txHash: broadcastTxHash,
					});
				}

				// No deposit hash and not a revert: a transient failure before the deposit
				// was broadcast (e.g. an approve-receipt timeout). Leave the row `submitted`
				// (null hash) so a keyed retry resumes rather than being stranded `failed`.
				request.log.warn(
					{ err: error, orgId },
					"treasury_deposit_prebroadcast_unconfirmed",
				);
				return reply.code(202).send({
					amount: amount.toString(),
					source: "direct",
					status: "submitted",
					token: token.token,
					tokenId: token.tokenId.toString(),
					txHash: null,
				});
			}

			await db
				.update(treasuryDeposits)
				.set({
					status: "confirmed",
					txHash: result.txHash.toLowerCase(),
					updatedAt: new Date(),
				})
				.where(eq(treasuryDeposits.id, pendingId));

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

type OrgMemberAllowlistRecord = {
	address: string;
	allowlist: {
		status: OrgMemberAllowlistStatus;
		txHash: string | null;
		updatedAt: Date;
	} | null;
	kyc: {
		approved: boolean;
		approvedAt: string | null;
		onboardingStatus: OnboardingStatus | null;
		provider: string | null;
		status: string;
	};
	orgId: string;
	userId: string;
};

async function loadOrgMemberAllowlist(
	db: Database,
	orgId: string,
	address: string,
): Promise<OrgMemberAllowlistRecord | null> {
	const [row] = await db
		.select({
			address: users.address,
			allowlistStatus: orgMemberAllowlist.status,
			allowlistTxHash: orgMemberAllowlist.txHash,
			allowlistUpdatedAt: orgMemberAllowlist.updatedAt,
			kycApprovedAt: kycRecords.approvedAt,
			kycProvider: kycRecords.provider,
			onboardingKycApprovedAt: onboardings.kycApprovedAt,
			onboardingStatus: onboardings.status,
			userId: orgMembers.userId,
		})
		.from(orgMembers)
		.innerJoin(users, eq(users.id, orgMembers.userId))
		.leftJoin(kycRecords, eq(kycRecords.userId, orgMembers.userId))
		.leftJoin(onboardings, eq(onboardings.userId, orgMembers.userId))
		.leftJoin(
			orgMemberAllowlist,
			and(
				eq(orgMemberAllowlist.orgId, orgMembers.orgId),
				eq(orgMemberAllowlist.userId, orgMembers.userId),
			),
		)
		.where(and(eq(orgMembers.orgId, orgId), eq(users.address, address)))
		.limit(1);

	if (!row) {
		return null;
	}

	const kycRecordApproved = row.kycApprovedAt !== null;
	const onboardingApproved =
		row.onboardingStatus !== null &&
		approvedKycOnboardingStatuses.has(row.onboardingStatus);
	const approved = kycRecordApproved || onboardingApproved;
	const approvedAt = row.kycApprovedAt ?? row.onboardingKycApprovedAt;

	return {
		address: row.address,
		allowlist:
			row.allowlistStatus === null
				? null
				: {
						status: row.allowlistStatus,
						txHash: row.allowlistTxHash,
						updatedAt: row.allowlistUpdatedAt!,
					},
		kyc: {
			approved,
			approvedAt: approvedAt?.toISOString() ?? null,
			onboardingStatus: row.onboardingStatus,
			provider: row.kycProvider,
			status: approved ? "approved" : (row.onboardingStatus ?? "not_started"),
		},
		orgId,
		userId: row.userId,
	};
}

async function recordMemberAllowlistChange({
	action,
	actor,
	chainEnv,
	chainId,
	db,
	member,
	result,
}: {
	action: "enable" | "revoke";
	actor: string;
	chainEnv: string;
	chainId: number;
	db: Database;
	member: OrgMemberAllowlistRecord;
	result: AllowlistActionResult;
}): Promise<void> {
	const now = new Date();
	const status: OrgMemberAllowlistStatus =
		action === "enable" ? "enabled" : "revoked";
	const txHash = normalizeTxHash(result.txHash);

	await db.transaction(async (tx) => {
		await tx
			.insert(orgMemberAllowlist)
			.values({
				orgId: member.orgId,
				status,
				txHash,
				updatedAt: now,
				userId: member.userId,
			})
			.onConflictDoUpdate({
				set: {
					status,
					txHash,
					updatedAt: now,
				},
				target: [orgMemberAllowlist.orgId, orgMemberAllowlist.userId],
			});

		await tx.insert(auditLog).values({
			action: `org_member_allowlist_${action}`,
			actor,
			meta: {
				address: getAddress(member.address),
				chainEnv,
				chainId,
				kyc: member.kyc,
				orgId: member.orgId,
				result,
				status,
				userId: member.userId,
			},
			subject: orgMemberAllowlistSubject(member.orgId, member.userId),
		});
	});
}

function serializeMemberAllowlist(
	member: OrgMemberAllowlistRecord,
	chain: AllowlistStatus,
	result?: AllowlistActionResult,
) {
	return {
		address: getAddress(member.address),
		chain,
		kyc: member.kyc,
		orgId: member.orgId,
		result,
		status: member.allowlist?.status ?? "not_requested",
		txHash: member.allowlist?.txHash ?? null,
		updatedAt: member.allowlist?.updatedAt.toISOString() ?? null,
		userId: member.userId,
	};
}

function withAllowlistChange(
	member: OrgMemberAllowlistRecord,
	status: OrgMemberAllowlistStatus,
	result: AllowlistActionResult,
): OrgMemberAllowlistRecord {
	return {
		...member,
		allowlist: {
			status,
			txHash: normalizeTxHash(result.txHash),
			updatedAt: new Date(),
		},
	};
}

function allowlistResultToStatus(result: AllowlistActionResult): AllowlistStatus {
	return {
		address: result.address,
		enabled: result.enabled,
		level:
			result.result === "enabled"
				? "1"
				: result.result === "revoked"
					? "0"
					: result.previousLevel,
	};
}

function normalizeMemberAddress(address: string): string | null {
	if (!isAddress(address, { strict: false })) {
		return null;
	}

	return getAddress(address).toLowerCase();
}

function normalizeTxHash(txHash: string | null): string | null {
	return txHash?.toLowerCase() ?? null;
}

function orgMemberAllowlistSubject(orgId: string, userId: string): string {
	return `org:${orgId}:member:${userId}:allowlist`;
}

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
