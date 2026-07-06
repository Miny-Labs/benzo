import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["network_admin", "auditor"]);

export const users = pgTable(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		address: text("address").notNull().unique(),
		roles: userRole("roles")
			.array()
			.notNull()
			.default(sql`ARRAY[]::user_role[]`),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [index("users_address_idx").on(table.address)],
);

export const sessions = pgTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("sessions_user_id_idx").on(table.userId),
		index("sessions_expires_at_idx").on(table.expiresAt),
	],
);

export const siweNonces = pgTable(
	"siwe_nonces",
	{
		nonce: text("nonce").primaryKey(),
		address: text("address").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("siwe_nonces_address_idx").on(table.address),
		index("siwe_nonces_expires_at_idx").on(table.expiresAt),
	],
);

export const auditLog = pgTable(
	"audit_log",
	{
		id: bigint("id", { mode: "bigint" })
			.primaryKey()
			.generatedAlwaysAsIdentity(),
		actor: text("actor").notNull(),
		action: text("action").notNull(),
		subject: text("subject").notNull(),
		meta: jsonb("meta").notNull().default({}),
		at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("audit_log_actor_idx").on(table.actor),
		index("audit_log_subject_idx").on(table.subject),
		index("audit_log_at_idx").on(table.at),
	],
);

export type UserRole = (typeof userRole.enumValues)[number];
