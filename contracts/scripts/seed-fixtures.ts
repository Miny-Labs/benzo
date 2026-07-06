import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ethers } from "hardhat";
import type { PoolClient } from "pg";
import {
	createEercAccount,
	serializeEercAccount,
	type EercAccount,
} from "./deploy/eerc-crypto";

export type SeedTarget = "fuji" | "benzonet" | "local";

export type DemoAccount = {
	address: string;
	eercAccount: EercAccount;
	handle: string;
	index: number;
	name: string;
	privateKey: string;
};

export type SeedConfig = {
	count: number;
	databaseUrl?: string;
	giftAmountRaw: bigint;
	nativeTargetWei: bigint;
	outputPath: string;
	payrollCsvPath: string;
	seedId: string;
	seedPhrase: string;
	target: SeedTarget;
	tusdcTargetRaw: bigint;
};

export type ChainAccountResult = {
	address: string;
	allowlistResult: string;
	allowlistTxHash: string | null;
	depositAmountRaw: string;
	depositTxHash: string | null;
	gasResult: string;
	gasTxHash: string | null;
	handle: string;
	name: string;
	privateBalanceRaw: string;
	publicBalanceRaw: string;
	registrationTxHash: string | null;
	tusdcTopUpResult: string;
	tusdcTopUpTxHash: string | null;
};

export type SeedTransferResult = {
	amountRaw: string;
	blockHash: string;
	blockNumber: string;
	blockTime: string;
	from: string;
	id: string;
	label: string;
	log: {
		address: string;
		data: string;
		logIndex: number;
		topics: string[];
	};
	to: string;
	txHash: string;
};

export type SeedInvoiceResult = {
	amountRaw: string;
	commitment: string;
	expiresAt: string;
	id: string | null;
	link: string;
	payee: string;
	payer: string;
	salt: string;
	status: "created" | "skipped_no_registry" | "already_created";
	txHash: string | null;
};

export type SeedGiftResult = {
	apiGiftAmount: string;
	escrowGiftId: string | null;
	escrowStatus: "created" | "skipped_no_escrow" | "already_created";
	escrowTxHash: string | null;
	expiresAt: string;
	inviteId: string;
	link: string;
	token: string;
	tokenHash: string;
};

export type SeedState = {
	accounts?: Array<{
		address: string;
		handle: string;
		name: string;
	}>;
	chainId?: number;
	gift?: SeedGiftResult;
	invoice?: SeedInvoiceResult;
	seedId: string;
	target: SeedTarget;
	transfers: Record<string, SeedTransferResult>;
	version: 1;
};

export type PostgresSeedSummary = {
	auditRowsInserted: number;
	contactsUpserted: number;
	eventsUpserted: number;
	giftInviteId: string;
	handlesSeeded: number;
	orgId: string;
	payrollRunId: string;
	treasury: "seeded" | "skipped_missing_app_master_key";
	usersSeeded: number;
};

const PROFILE_NAMES = [
	["maya", "Maya Chen"],
	["noah", "Noah Rivera"],
	["asha", "Asha Patel"],
	["leo", "Leo Brooks"],
	["iris", "Iris Morgan"],
	["owen", "Owen Kim"],
	["nina", "Nina Shah"],
	["eli", "Eli Carter"],
] as const;

const DEFAULT_SEED_COUNT = 4;
const DEFAULT_NATIVE_TARGET_WEI = 500_000_000_000_000_000n;
const DEFAULT_TUSDC_TARGET_RAW = 1_000_000_000n;
const DEFAULT_GIFT_AMOUNT_RAW = 25_000_000n;
const CONTRACTS_WORKSPACE = path.join(__dirname, "..");
const DEFAULT_OUTPUT_PATH = path.join(
	CONTRACTS_WORKSPACE,
	".seed-fixtures.local.json",
);
const DEFAULT_PAYROLL_CSV_PATH = path.join(
	CONTRACTS_WORKSPACE,
	".seed-payroll.local.csv",
);
const APP_MASTER_KEY_BYTES = 32;
const SEAL_NONCE_BYTES = 12;
const SEAL_TAG_BYTES = 16;
const SECP256K1_ORDER = BigInt(
	"0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

export function buildSeedConfig(env: NodeJS.ProcessEnv): SeedConfig {
	const target = parseTarget(env.BENZO_SEED_TARGET);
	const seedPhrase = env.BENZO_SEED_PHRASE?.trim();

	if (!seedPhrase) {
		throw new Error(
			"BENZO_SEED_PHRASE is required. Use a local demo-only phrase; do not reuse a real wallet mnemonic.",
		);
	}

	return {
		count: parsePositiveInteger(env.BENZO_SEED_COUNT, DEFAULT_SEED_COUNT),
		databaseUrl: env.DATABASE_URL?.trim() || undefined,
		giftAmountRaw: parseBigIntEnv(
			env.BENZO_SEED_GIFT_RAW,
			DEFAULT_GIFT_AMOUNT_RAW,
			"BENZO_SEED_GIFT_RAW",
		),
		nativeTargetWei: parseBigIntEnv(
			env.BENZO_SEED_NATIVE_WEI,
			DEFAULT_NATIVE_TARGET_WEI,
			"BENZO_SEED_NATIVE_WEI",
		),
		outputPath: path.resolve(env.BENZO_SEED_OUTPUT ?? DEFAULT_OUTPUT_PATH),
		payrollCsvPath: path.resolve(
			env.BENZO_SEED_PAYROLL_CSV ?? DEFAULT_PAYROLL_CSV_PATH,
		),
		seedId: hashHex(`seed-id:${seedPhrase}`).slice(0, 24),
		seedPhrase,
		target,
		tusdcTargetRaw: parseBigIntEnv(
			env.BENZO_SEED_TUSDC_RAW,
			DEFAULT_TUSDC_TARGET_RAW,
			"BENZO_SEED_TUSDC_RAW",
		),
	};
}

export function deriveDemoAccounts(config: SeedConfig): DemoAccount[] {
	return Array.from({ length: config.count }, (_, index) => {
		const privateKey = deterministicPrivateKey(
			config.seedPhrase,
			config.target,
			`eoa:${index}`,
		);
		const address = ethers.computeAddress(privateKey).toLowerCase();
		const eercAccount = createEercAccount(
			BigInt(
				deterministicPrivateKey(
					config.seedPhrase,
					config.target,
					`eerc:${index}`,
				),
			),
		);
		const [handleBase, name] = PROFILE_NAMES[index % PROFILE_NAMES.length];
		const cycle = Math.floor(index / PROFILE_NAMES.length);
		const handle = cycle === 0 ? handleBase : `${handleBase}${cycle + 1}`;

		return {
			address,
			eercAccount,
			handle,
			index,
			name,
			privateKey,
		};
	});
}

export function deriveTreasuryPrivateKey(config: SeedConfig): string {
	return deterministicPrivateKey(config.seedPhrase, config.target, "org-treasury");
}

export function deriveGiftClaimPrivateKey(config: SeedConfig): string {
	return deterministicPrivateKey(config.seedPhrase, config.target, "gift-claim");
}

export function buildPayrollCsv(accounts: DemoAccount[]): string {
	const contractors = accounts.length > 1 ? accounts.slice(1) : accounts;
	const rows = contractors.map((account, index) => {
		const amount = payrollAmount(index);
		return `@${account.handle},${amount}`;
	});

	return ["recipient,amount", ...rows].join("\n");
}

export async function writePayrollCsv(
	filePath: string,
	accounts: DemoAccount[],
): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${buildPayrollCsv(accounts)}\n`, {
		mode: 0o600,
	});
}

export async function loadSeedState(
	filePath: string,
	config: SeedConfig,
	chainId: number,
	options: { ignoreCache?: boolean } = {},
): Promise<SeedState> {
	if (!options.ignoreCache) {
		try {
			const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as SeedState;
			if (
				parsed.version === 1 &&
				parsed.seedId === config.seedId &&
				parsed.target === config.target &&
				parsed.chainId === chainId
			) {
				return {
					...parsed,
					transfers: parsed.transfers ?? {},
				};
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}

	return {
		chainId,
		seedId: config.seedId,
		target: config.target,
		transfers: {},
		version: 1,
	};
}

export async function writeSeedState(
	filePath: string,
	state: SeedState,
): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
}

export function buildInvoiceLink(input: {
	amountRaw: bigint;
	commitment: string;
	payee: string;
	salt: string;
	token: string;
}): string {
	const params = new URLSearchParams({
		amount: tokenText(input.amountRaw),
		commitment: input.commitment,
		payee: input.payee,
		salt: input.salt,
		token: input.token,
	});

	return `benzo://pay?${params.toString()}`;
}

export function buildGiftInvite(config: SeedConfig): Omit<
	SeedGiftResult,
	"escrowGiftId" | "escrowStatus" | "escrowTxHash" | "expiresAt"
> {
	const token = base64UrlHash(
		`gift-token:${config.seedPhrase}:${config.target}:${config.seedId}`,
	);
	const tokenHash = hashHex(token);

	return {
		apiGiftAmount: tokenText(config.giftAmountRaw),
		inviteId: deterministicUuid(`gift-invite:${tokenHash}`),
		link: `benzo://gift/${token}`,
		token,
		tokenHash,
	};
}

export function buildGiftEscrowLink(
	inviteLink: string,
	escrowGiftId: bigint | string | null | undefined,
): string {
	if (escrowGiftId === null || escrowGiftId === undefined) {
		return inviteLink;
	}

	const id = escrowGiftId.toString();
	if (id === "") {
		return inviteLink;
	}

	const params = new URLSearchParams({ escrowGiftId: id });
	return `${inviteLink}?${params.toString()}`;
}

export function transferPlans(accounts: DemoAccount[]): Array<{
	amountRaw: bigint;
	from: DemoAccount;
	id: string;
	label: string;
	to: DemoAccount;
}> {
	const recipients = accounts.slice(1, Math.min(accounts.length, 4));
	return recipients.map((to, index) => ({
		amountRaw: [25_000_000n, 18_750_000n, 42_500_000n][index] ?? 10_000_000n,
		from: accounts[0]!,
		id: `seed-transfer-${index + 1}`,
		label: `Demo private transfer ${index + 1}`,
		to,
	}));
}

export async function mirrorPostgresFixtures(input: {
	accounts: DemoAccount[];
	accountResults: ChainAccountResult[];
	chainId: number;
	config: SeedConfig;
	gift: SeedGiftResult;
	invoice: SeedInvoiceResult;
	transfers: SeedTransferResult[];
}): Promise<PostgresSeedSummary | null> {
	if (!input.config.databaseUrl) {
		return null;
	}

	const { Pool } = await import("pg");
	const pool = new Pool({ connectionString: input.config.databaseUrl });
	const client = await pool.connect();

	try {
		await client.query("begin");
		const userIds = await seedUsersAndOnboarding(client, input);
		const handlesSeeded = await seedHandles(client, input.accounts, userIds);
		const contactsUpserted = await seedContacts(client, input.accounts, userIds);
		const orgId = await seedOrg(client, input.accounts, userIds);
		const treasury = await seedTreasury(client, input.config, orgId, userIds[0]!);
		const payrollRunId = await seedPayroll(client, input.accounts, userIds, orgId);
		const giftInviteId = await seedGiftInvite(client, input.gift, userIds[0]!);
		const eventsUpserted = await seedEvents(client, input.transfers);
		const auditRowsInserted = await seedAuditLog(client, {
			giftInviteId,
			orgId,
			payrollRunId,
			target: input.config.target,
			userCount: input.accounts.length,
		});
		await client.query("commit");

		return {
			auditRowsInserted,
			contactsUpserted,
			eventsUpserted,
			giftInviteId,
			handlesSeeded,
			orgId,
			payrollRunId,
			treasury,
			usersSeeded: input.accounts.length,
		};
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

export function tokenText(raw: bigint): string {
	const whole = raw / 1_000_000n;
	const frac = (raw % 1_000_000n)
		.toString()
		.padStart(6, "0")
		.replace(/0+$/, "");

	return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

export function deterministicUuid(input: string): string {
	const bytes = Buffer.from(hashHex(input), "hex").subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");

	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

function parseTarget(value: string | undefined): SeedTarget {
	if (value === undefined || value.trim() === "") {
		return "local";
	}

	const target = value.trim().toLowerCase();
	if (target === "fuji" || target === "benzonet" || target === "local") {
		return target;
	}

	throw new Error("BENZO_SEED_TARGET must be fuji, benzonet, or local");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error("BENZO_SEED_COUNT must be a positive integer");
	}

	return parsed;
}

function parseBigIntEnv(
	value: string | undefined,
	fallback: bigint,
	name: string,
): bigint {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}

	if (!/^(0|[1-9][0-9]*)$/.test(value.trim())) {
		throw new Error(`${name} must be a non-negative integer`);
	}

	return BigInt(value.trim());
}

function deterministicPrivateKey(
	seedPhrase: string,
	target: SeedTarget,
	label: string,
): string {
	let material = `Benzo demo seed v1\n${target}\n${label}\n${seedPhrase}`;

	for (let attempt = 0; attempt < 8; attempt += 1) {
		const candidate = hashHex(`${material}\n${attempt}`);
		const value = BigInt(`0x${candidate}`);
		if (value > 0n && value < SECP256K1_ORDER) {
			return `0x${candidate}`;
		}
		material = hashHex(material);
	}

	throw new Error(`failed_to_derive_private_key:${label}`);
}

function hashHex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function base64UrlHash(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function payrollAmount(index: number): string {
	const amounts = ["1250.00", "980.50", "1425.75", "760.00", "1110.25"];
	return amounts[index % amounts.length]!;
}

async function seedUsersAndOnboarding(
	client: PoolClient,
	input: {
		accounts: DemoAccount[];
		accountResults: ChainAccountResult[];
		chainId: number;
		config: SeedConfig;
	},
): Promise<string[]> {
	const ids: string[] = [];

	for (const account of input.accounts) {
		const roles = account.index === 0 ? "{network_admin,auditor}" : "{}";
		const result = input.accountResults.find(
			(row) => row.address === account.address,
		);
		if (!result) {
			throw new Error(`missing_seed_account_result:${account.address}`);
		}

		const user = await client.query<{ id: string }>(
			`
				insert into users(address, roles)
				values ($1, $2::user_role[])
				on conflict (address) do update set roles = excluded.roles
				returning id
			`,
			[account.address, roles],
		);
		const userId = user.rows[0]!.id;
		ids.push(userId);

		await client.query(
			`
				insert into kyc_records(user_id, provider, payload, approved_at)
				values (
					$1,
					'mock',
					$2::jsonb,
					now()
				)
				on conflict (user_id) do update set
					provider = excluded.provider,
					payload = excluded.payload,
					approved_at = excluded.approved_at
			`,
			[
				userId,
				JSON.stringify({
					country: "US",
					label: "MOCK_KYC_NO_DOCUMENTS",
					name: account.name,
				}),
			],
		);

		await client.query(
			`
				insert into onboardings(
					user_id,
					status,
					chain_env,
					chain_id,
					mock_kyc_input,
					kyc_approved_at,
					allowlist_tx_hash,
					allowlist_result,
					allowlisted_at,
					gas_drip_tx_hash,
					gas_drip_result,
					gas_dripped_at,
					registration_last_checked_at,
					registration_completed_at,
					error,
					updated_at
				)
				values (
					$1,
					'complete',
					$2,
					$3,
					$4::jsonb,
					now(),
					$5,
					$6,
					now(),
					$7,
					$8,
					now(),
					now(),
					now(),
					null,
					now()
				)
				on conflict (user_id) do update set
					status = excluded.status,
					chain_env = excluded.chain_env,
					chain_id = excluded.chain_id,
					mock_kyc_input = excluded.mock_kyc_input,
					kyc_approved_at = excluded.kyc_approved_at,
					allowlist_tx_hash = excluded.allowlist_tx_hash,
					allowlist_result = excluded.allowlist_result,
					allowlisted_at = excluded.allowlisted_at,
					gas_drip_tx_hash = excluded.gas_drip_tx_hash,
					gas_drip_result = excluded.gas_drip_result,
					gas_dripped_at = excluded.gas_dripped_at,
					registration_last_checked_at = excluded.registration_last_checked_at,
					registration_completed_at = excluded.registration_completed_at,
					error = null,
					updated_at = now()
			`,
				[
				userId,
				input.config.target,
				input.chainId,
				JSON.stringify({ country: "US", name: account.name }),
				result.allowlistTxHash,
				result.allowlistResult,
				result.gasTxHash,
				result.gasResult,
			],
		);
	}

	return ids;
}

async function seedHandles(
	client: PoolClient,
	accounts: DemoAccount[],
	userIds: string[],
): Promise<number> {
	await client.query(
		"delete from handles where handle = any($1::text[]) or user_id = any($2::uuid[])",
		[accounts.map((account) => account.handle), userIds],
	);

	for (const [index, account] of accounts.entries()) {
		await client.query(
			"insert into handles(handle, user_id) values ($1, $2)",
			[account.handle, userIds[index]],
		);
	}

	return accounts.length;
}

async function seedContacts(
	client: PoolClient,
	accounts: DemoAccount[],
	userIds: string[],
): Promise<number> {
	let count = 0;

	for (const [ownerIndex, ownerId] of userIds.entries()) {
		for (const [contactIndex, account] of accounts.entries()) {
			if (ownerIndex === contactIndex) {
				continue;
			}

			await client.query(
				`
					insert into contacts(owner_user_id, contact_address, alias, favorite)
					values ($1, $2, $3, $4)
					on conflict (owner_user_id, contact_address) do update set
						alias = excluded.alias,
						favorite = excluded.favorite
				`,
				[
					ownerId,
					account.address,
					account.name,
					contactIndex === ((ownerIndex + 1) % accounts.length),
				],
			);
			count += 1;
		}
	}

	return count;
}

async function seedOrg(
	client: PoolClient,
	accounts: DemoAccount[],
	userIds: string[],
): Promise<string> {
	if (accounts.length === 0) {
		throw new Error("seed_org_requires_accounts");
	}

	const org = await client.query<{ id: string }>(
		`
			insert into orgs(name, slug)
			values ('Benzo Demo Studio', 'benzo-demo')
			on conflict (slug) do update set name = excluded.name
			returning id
		`,
	);
	const orgId = org.rows[0]!.id;

	for (const [index, userId] of userIds.entries()) {
		await client.query(
			`
				insert into org_members(org_id, user_id, role)
				values ($1, $2, $3::org_role)
				on conflict (org_id, user_id) do update set role = excluded.role
			`,
			[orgId, userId, index === 0 ? "owner" : index === 1 ? "operator" : "viewer"],
		);
	}

	return orgId;
}

async function seedTreasury(
	client: PoolClient,
	config: SeedConfig,
	orgId: string,
	ownerUserId: string,
): Promise<PostgresSeedSummary["treasury"]> {
	const masterKey = process.env.APP_MASTER_KEY?.replace(/^0x/i, "").trim();
	if (!masterKey) {
		return "skipped_missing_app_master_key";
	}

	const treasuryKey = deriveTreasuryPrivateKey(config);
	const treasuryAddress = ethers.computeAddress(treasuryKey).toLowerCase();

	await client.query(
		`
			insert into org_treasuries(
				org_id,
				address,
				sealed_eoa_key,
				consented_at,
				consented_by
			)
			values ($1, $2, $3, now(), $4)
			on conflict (org_id) do nothing
		`,
		[orgId, treasuryAddress, sealString(masterKey, treasuryKey), ownerUserId],
	);

	return "seeded";
}

async function seedPayroll(
	client: PoolClient,
	accounts: DemoAccount[],
	userIds: string[],
	orgId: string,
): Promise<string> {
	const payrollAccounts = accounts.length > 1 ? accounts.slice(1) : accounts;
	const runId = deterministicUuid(`payroll-run:${orgId}:seed-v1`);
	const totalAmount = sumDecimalAmounts(
		payrollAccounts.map((_, index) => payrollAmount(index)),
	);

	await client.query(
		`
			insert into payroll_runs(
				id,
				org_id,
				status,
				item_count,
				total_amount,
				created_by,
				error,
				updated_at
			)
			values ($1, $2, 'ready', $3, $4, $5, null, now())
			on conflict (id) do update set
				status = excluded.status,
				item_count = excluded.item_count,
				total_amount = excluded.total_amount,
				created_by = excluded.created_by,
				error = null,
				updated_at = now()
		`,
		[runId, orgId, payrollAccounts.length, totalAmount, userIds[0]],
	);

	for (const [rowIndex, account] of payrollAccounts.entries()) {
		await client.query(
			`
				insert into payroll_items(
					run_id,
					row_index,
					recipient_input,
					resolved_address,
					amount,
					status,
					error,
					updated_at
				)
				values ($1, $2, $3, $4, $5, 'pending', null, now())
				on conflict (run_id, row_index) do update set
					recipient_input = excluded.recipient_input,
					resolved_address = excluded.resolved_address,
					amount = excluded.amount,
					status = excluded.status,
					error = null,
					updated_at = now()
			`,
			[
				runId,
				rowIndex,
				`@${account.handle}`,
				account.address,
				payrollAmount(rowIndex),
			],
		);
	}

	return runId;
}

async function seedGiftInvite(
	client: PoolClient,
	gift: SeedGiftResult,
	creatorUserId: string,
): Promise<string> {
	await client.query(
		`
			insert into invites(
				id,
				creator_user_id,
				expires_at,
				gift_amount,
				kind,
				note,
				status,
				token_hash
			)
			values ($1, $2, $3, $4, 'gift', $5, 'created', $6)
			on conflict (id) do update set
				creator_user_id = excluded.creator_user_id,
				expires_at = excluded.expires_at,
				gift_amount = excluded.gift_amount,
				kind = excluded.kind,
				note = excluded.note,
				status = 'created',
				token_hash = excluded.token_hash
		`,
		[
			gift.inviteId,
			creatorUserId,
			gift.expiresAt,
			gift.apiGiftAmount,
			"Seeded unclaimed demo gift link",
			gift.tokenHash,
		],
	);

	return gift.inviteId;
}

async function seedEvents(
	client: PoolClient,
	transfers: SeedTransferResult[],
): Promise<number> {
	for (const transfer of transfers) {
		await client.query(
			`
				insert into events(
					tx_hash,
					log_index,
					block_number,
					block_hash,
					block_time,
					contract,
					event_name,
					from_addr,
					to_addr,
					raw_log
				)
				values (
					$1,
					$2,
					$3,
					$4,
					$5,
					$6,
					'PrivateTransfer',
					$7,
					$8,
					$9::jsonb
				)
				on conflict (tx_hash, log_index) do update set
					block_number = excluded.block_number,
					block_hash = excluded.block_hash,
					block_time = excluded.block_time,
					contract = excluded.contract,
					event_name = excluded.event_name,
					from_addr = excluded.from_addr,
					to_addr = excluded.to_addr,
					raw_log = excluded.raw_log
			`,
			[
				transfer.txHash,
				transfer.log.logIndex,
				transfer.blockNumber,
				transfer.blockHash,
				transfer.blockTime,
				transfer.log.address,
				transfer.from,
				transfer.to,
				JSON.stringify({
					address: transfer.log.address,
					data: transfer.log.data,
					topics: transfer.log.topics,
				}),
			],
		);

		await client.query(
			`
				insert into event_links(tx_hash, object_type, object_id, label)
				values ($1, 'seed_transfer', $2, $3)
				on conflict (object_type, object_id, tx_hash) do update set
					label = excluded.label
			`,
			[transfer.txHash, transfer.id, transfer.label],
		);
	}

	return transfers.length;
}

async function seedAuditLog(
	client: PoolClient,
	input: {
		giftInviteId: string;
		orgId: string;
		payrollRunId: string;
		target: SeedTarget;
		userCount: number;
	},
): Promise<number> {
	await client.query(
		`
			insert into audit_log(actor, action, subject, meta)
			values (
				'seed',
				'demo_world_seeded',
				$1,
				$2::jsonb
			)
		`,
		[
			`seed:${input.target}`,
			JSON.stringify({
				giftInviteId: input.giftInviteId,
				orgId: input.orgId,
				payrollRunId: input.payrollRunId,
				userCount: input.userCount,
			}),
		],
	);

	return 1;
}

function sealString(masterKeyHex: string, value: string): Buffer {
	const key = Buffer.from(masterKeyHex, "hex");
	if (key.length !== APP_MASTER_KEY_BYTES) {
		throw new Error(
			`APP_MASTER_KEY must decode to ${APP_MASTER_KEY_BYTES} bytes; got ${key.length}`,
		);
	}

	const nonce = randomBytes(SEAL_NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.from(value, "utf8")),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();

	if (tag.length !== SEAL_TAG_BYTES) {
		throw new Error("aes_gcm_tag_size_mismatch");
	}

	return Buffer.concat([nonce, tag, ciphertext]);
}

function sumDecimalAmounts(amounts: string[]): string {
	let scaled = 0n;
	for (const amount of amounts) {
		const [whole, fraction = ""] = amount.split(".");
		scaled +=
			BigInt(whole ?? "0") * 1_000_000n +
			BigInt((fraction + "000000").slice(0, 6));
	}

	return tokenText(scaled);
}

export function accountOutput(account: DemoAccount) {
	return {
		address: account.address,
		eercPublicKey: serializeEercAccount(account.eercAccount).publicKey,
		handle: account.handle,
		name: account.name,
	};
}
