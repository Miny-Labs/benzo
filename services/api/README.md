# @benzo/api

Fastify service for Benzo off-chain workflows. It owns HTTP, Postgres,
Drizzle migrations, pg-boss jobs, SIWE sessions, and health checks.

## Commands

```bash
pnpm --filter @benzo/api dev
pnpm --filter @benzo/api db:migrate
pnpm --filter @benzo/api index:backfill --from-block 12345
pnpm --filter @benzo/api test
pnpm --filter @benzo/api build
```

`GET /healthz` checks Postgres with `select 1` and reads the current block
number from `BENZONET_RPC_URL`.

## Environment

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | Yes | Postgres connection string used by Drizzle and pg-boss. |
| `BENZONET_RPC_URL` | No | Avalanche Fuji, local anvil, or BenzoNet JSON-RPC URL used for health, SIWE signature verification fallbacks, and the eERC indexer. Defaults to the live Fuji RPC. |
| `OPS_PRIVATE_KEY` | Yes | `0x`-prefixed operator key reserved for later workflow jobs. It is validated at boot but not logged. |
| `APP_MASTER_KEY` | Yes | 32-byte hex key reserved for libsodium secretbox encrypted-at-rest fields. It may include `0x`; the service normalizes it internally. |
| `BENZONET_CHAIN_ID` | No | SIWE chain id. Defaults to Fuji `43113`; set to BenzoNet `68420` when `CHAIN_ENV=benzonet`. |
| `CHAIN_ENV` | No | `fuji` or `benzonet`. Defaults to `fuji` when `BENZONET_CHAIN_ID=43113`, otherwise `benzonet`. Config load rejects mismatched chain ids. Fuji records tx allowlist as a no-op and drips gas with a plain AVAX transfer. |
| `KYC_PROVIDER` | No | Currently only `mock`. The mock provider records name/country only and never accepts documents. |
| `DRIP_WEI` | No | Native gas amount to send/mint during onboarding. Defaults to `500000000000000000` (0.5 native). |
| `DRIP_BALANCE_THRESHOLD_WEI` | No | Skip gas drip when the user balance is already at least this amount. Defaults to `500000000000000000`. |
| `EERC_REGISTRAR_ADDRESS` | No | Registrar contract override for onboarding registration polling. If omitted, the API looks in the deployment manifest. |
| `EERC_DEPLOYMENT_MANIFEST` | No | Deployment manifest path used to discover the Registrar address. Defaults to `contracts/deployments/{CHAIN_ENV}.json`. |
| `ONBOARDING_REGISTRATION_POLL_SECONDS` | No | Registration polling interval. Defaults to `15`. |
| `BENZONET_CHAIN_ID` | No | SIWE chain id. Defaults to Fuji `43113` until the BenzoNet VM chain id is assigned. |
| `EERC_ENCRYPTED_ERC_ADDRESS` | No | EncryptedERC contract address to index. Defaults to Fuji `0x46688f1704a69a6c276cCCB823E36C80787B0FA2`. |
| `EERC_REGISTRAR_ADDRESS` | No | Registrar contract address to index. Defaults to Fuji `0x9a63FEa9851097DBAf3757b636217fdde50ABaF0`. |
| `INDEXER_CONFIRMATIONS` | No | Confirmation depth before logs are indexed. Defaults to `6`. |
| `INDEXER_ENABLED` | No | Set to `false` to disable the pg-boss scheduled poller. Defaults to `true`. |
| `INDEXER_MAX_WINDOW_BLOCKS` | No | Maximum log scan window. Defaults to `2000`. |
| `INDEXER_POLL_CRON` | No | pg-boss cron expression for polling. Defaults to every 5 seconds, `*/5 * * * * *`. |
| `INDEXER_START_BLOCK` | No | Initial block when no cursor exists. Defaults to `0`; set this to the deployment block in production. |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `HOST` | No | Listen host. Defaults to `0.0.0.0`. |
| `LOG_LEVEL` | No | Pino log level. Defaults to `info`. |
| `SESSION_COOKIE_NAME` | No | httpOnly session cookie name. Defaults to `benzo_session`. |
| `SESSION_TTL_DAYS` | No | Session lifetime. Defaults to `7`. |
| `SIWE_NONCE_TTL_MINUTES` | No | Nonce lifetime. Defaults to `10`. |

## Data Classification

| Data | Classification | Storage |
|---|---|---|
| Wallet address | Plaintext | Stored in `users.address` and `siwe_nonces.address` so sessions and roles can bind to an EVM account. |
| User roles | Plaintext | Stored in `users.roles`; these are operational authorization labels only. |
| Session id | Plaintext secret | Stored in `sessions.id` and sent only as an httpOnly SameSite=Lax cookie. |
| SIWE nonce | Plaintext secret | Stored in `siwe_nonces.nonce` until it is consumed or expires. |
| Mock KYC payload | Plaintext MOCK workflow data | Stored in `kyc_records.payload` as name/country only with `MOCK_KYC_NO_DOCUMENTS`. Do not store documents or real-provider payloads here. |
| Onboarding state | Plaintext workflow state | Stored in `onboardings` and `drips`, including status, tx hashes, and operational errors. This is workflow tracking, not payment privacy. |
| Audit metadata | Plaintext by default | Stored in `audit_log.meta`; do not put private payment details here. Future fields that need at-rest privacy should use `APP_MASTER_KEY` and libsodium secretbox before insertion. |
| Handles | Plaintext public routing data | Stored in `handles.handle` and mirrored from HandleRegistry. Contract state is authoritative; the table is a read cache. |
| Contacts | Plaintext user workflow data | Stored in `contacts` per owner wallet. Contact addresses and aliases are not payment privacy data. |
| Invite tokens | Hashed secret | Only `sha256(raw_token)` is stored in `invites.token_hash`; raw claim URLs are returned once on creation and cannot be reconstructed from the DB. |
| Gift metadata | Workflow metadata | Stored in `invites.kind`, `gift_amount`, and `note`; the API does not custody funds, keys, ciphertexts, or proofs. |
| eERC decryption keys | Never server-side | Keys remain wallet-derived/client-side. This scaffold does not accept or persist them. |
| eERC event routing metadata | Plaintext | Stored in `events.tx_hash`, `events.log_index`, `events.block_number`, `events.block_hash`, `events.block_time`, `events.contract`, `events.event_name`, `events.from_addr`, and `events.to_addr` so participants can fetch activity without browser chain rescans. |
| eERC raw log bytes | Opaque chain bytes | Stored in `events.raw_log` as `address`, `topics`, and ABI `data` hex for replay/debugging. The API does not materialize decoded consumer amount fields from these bytes into columns or response fields. |
| eERC ciphertext/PCT blobs | Opaque bytes | Stored in `events.ciphertext` and `events.amount_pct`; returned as hex strings. The API does not decrypt, interpret, or convert these blobs to amounts. |
| eERC decryption keys | Never server-side | Consumer keys remain wallet-derived/client-side and never leave the device. The server decrypts only future org-treasury activity where the org opts into a managed key, and future auditor compliance views; those are separate authorization boundaries and must not be used for consumer activity. |
| Proving artifacts or secrets | Never server-side | Generated proving artifacts and secrets must not be committed or stored by the API. |

## Activity Indexer

The pg-boss poller schedules `eerc.indexer.poll` every 5 seconds by default. It
indexes confirmed logs from `EncryptedERC` and `Registrar` in windows of at most
`INDEXER_MAX_WINDOW_BLOCKS`, upserts by `(tx_hash, log_index)`, and advances
`chain_cursor.last_block` only after each batch commits. `chain_cursor` also
stores the last block hash so a parent-hash mismatch can rewind and rescan the
previous window.

Indexed event names are `PrivateTransfer`, `Deposit`, `Withdraw`,
`PrivateMint`, `PrivateBurn`, `Register`, and `AuditorChanged`.

Routes:

- `GET /activity?address=&cursor=&limit=` returns activity for the authenticated
  wallet only. `cursor` is the returned `blockNumber:logIndex` value.
- `GET /receipts/:txHash` returns receipt events and `event_links` labels only
  when the authenticated wallet is a participant.
- `GET /activity/stream` is a participant-scoped SSE stream for live activity.
- `GET /admin/indexer` returns lag, cursors, and event counts for
  `network_admin` users.

`event_links` correlates tx hashes to product objects such as onboardings,
invites, and later payroll items so receipts can show labels like
`Payroll June` without changing indexed event privacy.

The backfill command uses the same scanner path as the poller:

```bash
pnpm --filter @benzo/api index:backfill --from-block <n>
```

## Auth Flow

1. `GET /auth/nonce?address=0x...` creates a short-lived nonce bound to the wallet address.
2. The client signs an EIP-4361 SIWE message for `BENZONET_CHAIN_ID`.
3. `POST /auth/verify` verifies the nonce, chain id, domain, and signature, then sets the session cookie.
4. `GET /auth/me` returns the authenticated wallet and roles.
5. `POST /auth/logout` deletes the server session and clears the cookie.

The role decorators are `requireAuth` and `requireRole("network_admin" |
"auditor")`.

## Onboarding API

- `POST /onboarding/start` starts or resumes the authenticated user's workflow and enqueues `onboarding.advance` with a per-address singleton key.
- `GET /onboarding/status` returns the authenticated user's current workflow state and tx hashes.
- `GET /onboarding/status/stream` streams status updates as SSE and closes once the workflow reaches `complete` or `failed`.
- `GET /admin/onboardings?status=` lists recent onboarding rows for `network_admin` operators.

## Identity Routes

- `POST /handles` claims a lowercase `@handle` through the injected
  HandleRegistry client and mirrors the result to Postgres.
- `GET /resolve/:handle` returns public routing data with `Cache-Control:
  public, max-age=60`, an `ETag`, and a `source` field (`chain` or `cache`).
- `GET/POST/PATCH/DELETE /contacts` manages the authenticated user's contact
  book and enriches list responses with cached handles plus eERC registration
  status from the chain client.
- `POST /invites` creates invite or gift-link metadata and returns the raw token
  exactly once. `GET /invites/:token` exposes kind, note, creator handle, and
  status, never gift amount. `POST /invites/:token/claim` marks the invite
  claimed and triggers the onboarding orchestrator interface for the claimant.
