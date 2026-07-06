# @benzo/api

Fastify service for Benzo off-chain workflows. It owns HTTP, Postgres,
Drizzle migrations, pg-boss jobs, SIWE sessions, and health checks.

## Commands

```bash
pnpm --filter @benzo/api dev
pnpm --filter @benzo/api db:migrate
pnpm --filter @benzo/api test
pnpm --filter @benzo/api build
```

`GET /healthz` checks Postgres with `select 1` and reads the current block
number from `BENZONET_RPC_URL`.

## Environment

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | Yes | Postgres connection string used by Drizzle and pg-boss. |
| `BENZONET_RPC_URL` | Yes | Avalanche Fuji, local anvil, or BenzoNet JSON-RPC URL used for health and SIWE signature verification fallbacks. |
| `OPS_PRIVATE_KEY` | Yes | `0x`-prefixed operator key reserved for later workflow jobs. It is validated at boot but not logged. |
| `APP_MASTER_KEY` | Yes | 32-byte hex key reserved for libsodium secretbox encrypted-at-rest fields. It may include `0x`; the service normalizes it internally. |
| `BENZONET_CHAIN_ID` | No | SIWE chain id. Defaults to Fuji `43113` until the BenzoNet VM chain id is assigned. |
| `CHAIN_ENV` | No | `fuji` or `benzonet`. Defaults to `fuji` when `BENZONET_CHAIN_ID=43113`, otherwise `benzonet`. Fuji records tx allowlist as a no-op and drips gas with a plain AVAX transfer. |
| `KYC_PROVIDER` | No | Currently only `mock`. The mock provider records name/country only and never accepts documents. |
| `DRIP_WEI` | No | Native gas amount to send/mint during onboarding. Defaults to `500000000000000000` (0.5 native). |
| `DRIP_BALANCE_THRESHOLD_WEI` | No | Skip gas drip when the user balance is already at least this amount. Defaults to `500000000000000000`. |
| `EERC_REGISTRAR_ADDRESS` | No | Registrar contract override for onboarding registration polling. If omitted, the API looks in the deployment manifest. |
| `EERC_DEPLOYMENT_MANIFEST` | No | Deployment manifest path used to discover the Registrar address. Defaults to `contracts/deployments/{CHAIN_ENV}.json`. |
| `ONBOARDING_REGISTRATION_POLL_SECONDS` | No | Registration polling interval. Defaults to `15`. |
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
| eERC decryption keys | Never server-side | Keys remain wallet-derived/client-side. This scaffold does not accept or persist them. |
| Proving artifacts or secrets | Never server-side | Generated proving artifacts and secrets must not be committed or stored by the API. |

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
