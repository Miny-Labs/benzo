import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
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

export type MockKycInputPayload = {
	country?: string;
	name?: string;
};

export const inviteKind = pgEnum("invite_kind", ["invite", "gift"]);
export const inviteStatus = pgEnum("invite_status", [
	"created",
	"claimed",
	"expired",
	"cancelled",
]);

const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
	dataType() {
		return "bytea";
	},
	fromDriver(value) {
		return coerceBuffer(value);
	},
});

const byteaArray = customType<{
	data: Buffer[];
	driverData: Buffer[] | string;
}>({
	dataType() {
		return "bytea[]";
	},
	fromDriver(value) {
		if (Array.isArray(value)) {
			return value.map((item) => coerceBuffer(item));
		}

		return [...value.matchAll(/\\{1,2}x([0-9a-fA-F]+)/g)].map((match) =>
			Buffer.from(match[1] ?? "", "hex"),
		);
	},
});

function coerceBuffer(value: Buffer | string): Buffer {
	if (Buffer.isBuffer(value)) {
		return value;
	}

	return Buffer.from(value.replace(/^\\x/i, ""), "hex");
}

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
		mockKycInput: jsonb("mock_kyc_input").$type<MockKycInputPayload>(),
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

export const handles = pgTable(
	"handles",
	{
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		handle: text("handle").notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("handles_handle_idx").on(table.handle),
		uniqueIndex("handles_user_id_idx").on(table.userId),
	],
);

export const contacts = pgTable(
	"contacts",
	{
		alias: text("alias"),
		contactAddress: text("contact_address").notNull(),
		favorite: boolean("favorite").notNull().default(false),
		ownerUserId: uuid("owner_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
	},
	(table) => [
		uniqueIndex("contacts_owner_contact_idx").on(
			table.ownerUserId,
			table.contactAddress,
		),
		index("contacts_owner_user_id_idx").on(table.ownerUserId),
	],
);

export const invites = pgTable(
	"invites",
	{
		claimedBy: uuid("claimed_by").references(() => users.id, {
			onDelete: "set null",
		}),
		creatorUserId: uuid("creator_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		giftAmount: text("gift_amount"),
		id: uuid("id").defaultRandom().primaryKey(),
		kind: inviteKind("kind").notNull(),
		note: text("note"),
		status: inviteStatus("status").notNull().default("created"),
		tokenHash: text("token_hash").notNull(),
	},
	(table) => [
		uniqueIndex("invites_token_hash_idx").on(table.tokenHash),
		index("invites_creator_user_id_idx").on(table.creatorUserId),
		index("invites_claimed_by_idx").on(table.claimedBy),
		index("invites_status_expires_at_idx").on(table.status, table.expiresAt),
	],
);

export const chainCursor = pgTable("chain_cursor", {
	contract: text("contract").primaryKey(),
	lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
	lastBlockHash: text("last_block_hash"),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const events = pgTable(
	"events",
	{
		id: bigint("id", { mode: "bigint" })
			.primaryKey()
			.generatedAlwaysAsIdentity(),
		txHash: text("tx_hash").notNull(),
		logIndex: integer("log_index").notNull(),
		blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
		blockHash: text("block_hash").notNull(),
		blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
		contract: text("contract").notNull(),
		eventName: text("event_name").notNull(),
		fromAddr: text("from_addr"),
		toAddr: text("to_addr"),
		ciphertext: byteaArray("ciphertext")
			.notNull()
			.default(sql`ARRAY[]::bytea[]`),
		amountPct: bytea("amount_pct"),
		rawLog: jsonb("raw_log").notNull(),
		indexedAt: timestamp("indexed_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("events_tx_hash_log_index_uidx").on(
			table.txHash,
			table.logIndex,
		),
		index("events_from_addr_idx").on(table.fromAddr),
		index("events_to_addr_idx").on(table.toAddr),
		index("events_block_number_idx").on(table.blockNumber),
		index("events_contract_block_number_idx").on(
			table.contract,
			table.blockNumber,
		),
	],
);

export const eventLinks = pgTable(
	"event_links",
	{
		id: bigint("id", { mode: "bigint" })
			.primaryKey()
			.generatedAlwaysAsIdentity(),
		txHash: text("tx_hash").notNull(),
		objectType: text("object_type").notNull(),
		objectId: text("object_id").notNull(),
		label: text("label").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("event_links_tx_hash_idx").on(table.txHash),
		uniqueIndex("event_links_object_uidx").on(
			table.objectType,
			table.objectId,
			table.txHash,
		),
	],
);

export type UserRole = (typeof userRole.enumValues)[number];
export type OnboardingStatus = (typeof onboardingStatus.enumValues)[number];
export type InviteKind = (typeof inviteKind.enumValues)[number];
export type InviteStatus = (typeof inviteStatus.enumValues)[number];
