import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["network_admin", "auditor"]);
export const onboardingStatus = pgEnum("onboarding_status", [
	"pending_kyc",
	"kyc_approved",
	"allowlisted",
	"gas_dripped",
	"awaiting_registration",
	"complete",
	"failed",
]);

export type MockKycPayload = {
	country: string;
	label: "MOCK_KYC_NO_DOCUMENTS";
	name: string;
};

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

export const kycRecords = pgTable(
	"kyc_records",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" })
			.unique(),
		provider: text("provider").notNull().default("mock"),
		payload: jsonb("payload").$type<MockKycPayload>().notNull(),
		approvedAt: timestamp("approved_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("kyc_records_user_id_idx").on(table.userId),
		index("kyc_records_provider_idx").on(table.provider),
	],
);

export const onboardings = pgTable(
	"onboardings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" })
			.unique(),
		status: onboardingStatus("status").notNull().default("pending_kyc"),
		chainEnv: text("chain_env").notNull(),
		chainId: integer("chain_id").notNull(),
		kycApprovedAt: timestamp("kyc_approved_at", { withTimezone: true }),
		allowlistTxHash: text("allowlist_tx_hash"),
		allowlistResult: text("allowlist_result"),
		allowlistedAt: timestamp("allowlisted_at", { withTimezone: true }),
		gasDripTxHash: text("gas_drip_tx_hash"),
		gasDripResult: text("gas_drip_result"),
		gasDrippedAt: timestamp("gas_dripped_at", { withTimezone: true }),
		registrationLastCheckedAt: timestamp("registration_last_checked_at", {
			withTimezone: true,
		}),
		registrationCompletedAt: timestamp("registration_completed_at", {
			withTimezone: true,
		}),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("onboardings_user_id_idx").on(table.userId),
		index("onboardings_status_idx").on(table.status),
		index("onboardings_updated_at_idx").on(table.updatedAt),
	],
);

export const drips = pgTable(
	"drips",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		address: text("address").notNull(),
		chainEnv: text("chain_env").notNull(),
		chainId: integer("chain_id").notNull(),
		amountWei: text("amount_wei").notNull(),
		txHash: text("tx_hash").notNull(),
		mode: text("mode").notNull(),
		drippedAt: timestamp("dripped_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("drips_address_idx").on(table.address),
		index("drips_address_dripped_at_idx").on(table.address, table.drippedAt),
		index("drips_user_id_idx").on(table.userId),
	],
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
export type OnboardingStatus = (typeof onboardingStatus.enumValues)[number];
