import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { attestationSignerAddress, buildProofOfPayment } from "../disclosure/attest.js";
import { verifyDisclosure } from "../disclosure/verify.js";

// Selective disclosure / proof-of-payment (W3).
//
// HONEST SCOPE: eERC v0.0.4 has no disclosure circuit, so these endpoints are
// reveal-and-verify, not zero-knowledge disclosure proofs:
//   - POST /disclosure/verify         Tier A, trustless self-disclosure.
//   - POST /disclosure/proof-of-payment  Tier B, server-side auditor-signed.
//   - GET  /disclosure/attestation-key   the Tier B signer address.
// Proof-of-exact-balance / balance-range disclosure is deliberately out of
// scope: it cannot be done by revealing an existing PCT and would require a new
// circuit. Tracked as future circuit work.

type DisclosureRoutesOptions = {
	config: ApiConfig;
	db: Database;
};

const bigintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const logIndexSchema = z.coerce.number().int().nonnegative();

const verifyBodySchema = z.object({
	claimedAmount: bigintString,
	encRandom: bigintString,
	from: z.string().optional(),
	logIndex: logIndexSchema,
	to: z.string().optional(),
	txHash: txHashSchema,
});

const proofOfPaymentBodySchema = z.object({
	logIndex: logIndexSchema,
	txHash: txHashSchema,
});

export const disclosureRoutes: FastifyPluginAsync<DisclosureRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.post("/disclosure/verify", async (request, reply) => {
		const body = verifyBodySchema.safeParse(request.body);

		if (!body.success) {
			return reply.code(400).send({ error: "invalid_disclosure_payload" });
		}

		const result = await verifyDisclosure(options.db, {
			logIndex: body.data.logIndex,
			reveal: {
				claimedAmount: BigInt(body.data.claimedAmount),
				encRandom: BigInt(body.data.encRandom),
				from: body.data.from,
				to: body.data.to,
			},
			txHash: body.data.txHash,
		});

		return reply.send(result);
	});

	fastify.post(
		"/disclosure/proof-of-payment",
		{ preHandler: fastify.requireAuth },
		async (request, reply) => {
			const body = proofOfPaymentBodySchema.safeParse(request.body);

			if (!body.success || !request.user) {
				return reply.code(400).send({ error: "invalid_disclosure_payload" });
			}

			const result = await buildProofOfPayment(options.db, options.config, {
				logIndex: body.data.logIndex,
				requesterAddress: request.user.address,
				txHash: body.data.txHash,
			});

			if (result.ok) {
				return reply.send({ packet: result.packet });
			}

			switch (result.reason) {
				case "attestation_key_not_configured":
					return reply
						.code(503)
						.send({ error: "attestation_key_not_configured" });
				case "not_a_party":
					return reply.code(403).send({ error: "forbidden" });
				case "event_not_found":
					return reply.code(404).send({ error: "event_not_found" });
				default:
					return reply.code(409).send({ error: result.reason });
			}
		},
	);

	fastify.get("/disclosure/attestation-key", async (_request, reply) => {
		const address = attestationSignerAddress(options.config);

		if (!address) {
			return reply.code(503).send({ error: "attestation_key_not_configured" });
		}

		return reply.send({ attestationAddress: address });
	});
};
