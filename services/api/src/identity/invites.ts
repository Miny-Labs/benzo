import { createHash, randomBytes } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { invites } from "../db/schema.js";

export function createInviteToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export async function expireCreatedInvites(db: Database): Promise<number> {
	const rows = await db
		.update(invites)
		.set({ status: "expired" })
		.where(and(eq(invites.status, "created"), lte(invites.expiresAt, new Date())))
		.returning({ id: invites.id });

	return rows.length;
}
