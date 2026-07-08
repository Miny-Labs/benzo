import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { handles, users } from "../db/schema.js";
import type { IdentityChainClient } from "../identity/chain.js";

const HANDLE_PATTERN = /^@?[a-z0-9_]{3,20}$/;

const resolveRecipientBodySchema = z
	.object({
		address: z.string().trim().optional(),
		handle: z.string().trim().toLowerCase().optional(),
	})
	.strict()
	.refine((value) => Boolean(value.address) !== Boolean(value.handle));

type TransfersRoutesOptions = {
	db: Database;
	identityChain: IdentityChainClient;
};

export const transfersRoutes: FastifyPluginAsync<TransfersRoutesOptions> = async (
	fastify,
	options,
) => {
	fastify.post("/transfers/resolve-recipient", async (request, reply) => {
		const body = resolveRecipientBodySchema.safeParse(request.body);

		if (!body.success) {
			return reply.code(400).send({ error: "invalid_recipient" });
		}

		const addressResult = body.data.address
			? parseAddress(body.data.address)
			: await readAddressForHandle(options.db, body.data.handle ?? "");

		if (!addressResult.ok) {
			return reply.code(addressResult.statusCode).send({
				error: addressResult.error,
			});
		}

		let registeredOnEerc: boolean;

		try {
			const registrations = await options.identityChain.getRegistrationStatuses([
				addressResult.address,
			]);
			registeredOnEerc =
				registrations.get(addressResult.address.toLowerCase()) ?? false;
		} catch (error) {
			request.log.warn(
				{ address: addressResult.address, err: error },
				"recipient registration lookup failed",
			);
			return reply
				.code(503)
				.send({ error: "registration_status_unavailable" });
		}

		return {
			address: addressResult.address,
			canReceivePrivately: registeredOnEerc,
			registeredOnEerc,
		};
	});
};

function parseAddress(
	address: string,
):
	| { address: string; ok: true }
	| { error: "invalid_recipient"; ok: false; statusCode: 400 } {
	if (!isAddress(address, { strict: false })) {
		return { error: "invalid_recipient", ok: false, statusCode: 400 };
	}

	return { address: getAddress(address).toLowerCase(), ok: true };
}

async function readAddressForHandle(
	db: Database,
	handle: string,
): Promise<
	| { address: string; ok: true }
	| {
			error: "invalid_handle" | "recipient_not_found";
			ok: false;
			statusCode: 400 | 404;
	  }
> {
	const normalizedHandle = handle.startsWith("@") ? handle.slice(1) : handle;

	if (!HANDLE_PATTERN.test(handle)) {
		return { error: "invalid_handle", ok: false, statusCode: 400 };
	}

	const [row] = await db
		.select({
			address: users.address,
		})
		.from(handles)
		.innerJoin(users, eq(users.id, handles.userId))
		.where(eq(handles.handle, normalizedHandle))
		.limit(1);

	if (!row) {
		return { error: "recipient_not_found", ok: false, statusCode: 404 };
	}

	return { address: row.address, ok: true };
}
