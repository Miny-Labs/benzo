import type { FastifyPluginAsync } from "fastify";
import { getAddress, isAddress, pad, type Hex } from "viem";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import type { OnrampChainClient } from "../onramp/chain.js";
import { resolveSourceDomain } from "../onramp/domains.js";
import { encodeOnrampHookData } from "../onramp/hookdata.js";
import {
	createIntent,
	getIntentById,
	listIntentsByAddress,
	serializeIntent,
} from "../onramp/service.js";

// CCTP V2 fast-transfer tuning for the burn the wallet signs on the source
// chain. minFinalityThreshold 2000 = standard (hard-finality) transfer, which
// needs no per-transfer fee; 1000 would be fast/soft-finality and would require
// a non-zero maxFee. These are CCTP protocol params, not chain constants.
const DEFAULT_MAX_FEE = "0";
const DEFAULT_MIN_FINALITY_THRESHOLD = 2000;

const txHashPattern = /^0x[0-9a-fA-F]{64}$/;
const tokenSchema = z.enum(["usdc", "eurc"]);

const quoteBodySchema = z
	.object({
		token: tokenSchema.optional(),
	})
	.optional();

const intentBodySchema = z.object({
	sourceDomain: z.coerce.number().int().nonnegative(),
	sourceTxHash: z.string().regex(txHashPattern),
	token: tokenSchema,
	// Optional client hint; the authoritative amount is read from the attested
	// CCTP message by the relayer.
	amount: z
		.string()
		.regex(/^\d+$/)
		.optional(),
});

const intentIdParamsSchema = z.object({
	id: z.string().uuid(),
});

const intentsQuerySchema = z.object({
	address: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
});

type OnrampRoutesOptions = {
	config: ApiConfig;
	db: Database;
	onrampChain: OnrampChainClient;
};

export const onrampRoutes: FastifyPluginAsync<OnrampRoutesOptions> = async (
	fastify,
	options,
) => {
	const { config, db, onrampChain } = options;

	// POST /onramp/quote — server-authoritative CCTP burn parameters for the
	// authenticated user, including the hookData they sign so the mint hook
	// auto-deposits into their eERC balance.
	fastify.post(
		"/onramp/quote",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			if (!request.user) {
				return reply.code(401).send({ error: "unauthorized" });
			}

			const body = quoteBodySchema.safeParse(request.body);

			if (!body.success) {
				return reply.code(400).send({ error: "invalid_onramp_quote" });
			}

			const router = config.autoDepositRouterAddress;

			// The router is deployed in a later milestone; until its address lands in
			// the manifest the quote can't name a mintRecipient, so fail clearly
			// rather than emitting an unusable quote.
			if (!router) {
				return reply.code(503).send({ error: "router_not_configured" });
			}

			if (config.cctpDomain === null || config.cctpTokenMessenger === null) {
				return reply.code(503).send({ error: "cctp_not_configured" });
			}

			const key = await onrampChain.resolveUserKey(request.user.address);

			if (!key.registered || !key.publicKey) {
				return reply.code(409).send({ error: "not_eerc_registered" });
			}

			const user = getAddress(request.user.address);
			const hookData = encodeOnrampHookData({
				user,
				pkX: key.publicKey[0],
				pkY: key.publicKey[1],
			});
			// CCTP mintRecipient/destinationCaller are bytes32; a 20-byte EVM address
			// is left-padded to 32 bytes.
			const routerBytes32 = pad(getAddress(router) as Hex, { size: 32 });

			return reply.send({
				user,
				token: body.data?.token ?? "usdc",
				tokenMessenger: getAddress(config.cctpTokenMessenger),
				destinationDomain: config.cctpDomain,
				mintRecipient: routerBytes32,
				destinationCaller: routerBytes32,
				maxFee: DEFAULT_MAX_FEE,
				minFinalityThreshold: DEFAULT_MIN_FINALITY_THRESHOLD,
				hookData,
			});
		},
	);

	// POST /onramp/intents — record a pending onramp for a source-chain burn.
	fastify.post(
		"/onramp/intents",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			if (!request.user) {
				return reply.code(401).send({ error: "unauthorized" });
			}

			const body = intentBodySchema.safeParse(request.body);

			if (!body.success) {
				return reply.code(400).send({ error: "invalid_onramp_intent" });
			}

			const source = resolveSourceDomain(config.tier, body.data.sourceDomain);

			if (!source) {
				return reply.code(400).send({ error: "unsupported_source_domain" });
			}

			if (!source.tokens.includes(body.data.token)) {
				return reply.code(400).send({ error: "unsupported_source_token" });
			}

			// Reject users who cannot receive an auto-deposit: without an eERC
			// registration on the destination there is no public key to bind the
			// mint to.
			const key = await onrampChain.resolveUserKey(request.user.address);

			if (!key.registered || !key.publicKey) {
				return reply.code(409).send({ error: "not_eerc_registered" });
			}

			const { intent, created } = await createIntent(db, {
				amount: body.data.amount,
				destToken: body.data.token,
				sourceChainId: source.chainId,
				sourceDomain: source.domain,
				sourceTxHash: body.data.sourceTxHash,
				userAddress: request.user.address,
				userId: request.user.id,
				userPubKeyX: key.publicKey[0].toString(),
				userPubKeyY: key.publicKey[1].toString(),
			});

			// A burn tx maps to at most one intent (unique sourceTxHash). We do NOT
			// block a different-user "preclaim" with an error: the recipient is
			// authoritative on-chain (the attested burn's hookData, validated by the
			// router against the registrar), and the relayer (#111) re-associates this
			// intent's owner to that on-chain recipient at settle time. So a public-hash
			// preclaim can neither block the real recipient nor misdirect funds; the row
			// only exposes public-burn-derived data. Idempotent on re-submit.
			return reply
				.code(created ? 201 : 200)
				.send({ intent: serializeIntent(intent) });
		},
	);

	// GET /onramp/intents/:id — a single intent the caller owns.
	fastify.get(
		"/onramp/intents/:id",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			if (!request.user) {
				return reply.code(401).send({ error: "unauthorized" });
			}

			const params = intentIdParamsSchema.safeParse(request.params);

			if (!params.success) {
				return reply.code(400).send({ error: "invalid_intent_id" });
			}

			const intent = await getIntentById(db, params.data.id);

			// Ownership is enforced by returning 404 (existence not leaked) for
			// another user's intent.
			if (!intent || intent.userId !== request.user.id) {
				return reply.code(404).send({ error: "intent_not_found" });
			}

			return reply.send({ intent: serializeIntent(intent) });
		},
	);

	// GET /onramp/intents?address= — the caller's intents. `address`, when given,
	// must match the authenticated address.
	fastify.get(
		"/onramp/intents",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			if (!request.user) {
				return reply.code(401).send({ error: "unauthorized" });
			}

			const query = intentsQuerySchema.safeParse(request.query);

			if (!query.success) {
				return reply.code(400).send({ error: "invalid_intents_query" });
			}

			const address = authorizeRequestedAddress(
				request.user.address,
				query.data.address,
			);

			if (!address) {
				return reply.code(403).send({ error: "forbidden" });
			}

			const intents = await listIntentsByAddress(db, address, query.data.limit);

			return reply.send({ intents: intents.map(serializeIntent) });
		},
	);
};

function authorizeRequestedAddress(
	authenticatedAddress: string,
	requestedAddress: string | undefined,
): string | null {
	if (!requestedAddress) {
		return authenticatedAddress.toLowerCase();
	}

	if (!isAddress(requestedAddress, { strict: false })) {
		return null;
	}

	const normalized = getAddress(requestedAddress).toLowerCase();
	return normalized === authenticatedAddress.toLowerCase() ? normalized : null;
}
