# Benzo — Local Auditor Runbook

Everything you need to build, test, and exercise the real-USDC flows on **this
machine** (the clone, the `.env`, the keystore, and the built circuit artifacts
are already in place). Testnet only — no mainnet, no real funds at risk.

---

## 0. Orientation — which repo

```bash
cd "/Users/akshmnd/Dev Projects/stellar-benzo"      # ← THE repo. work here.
```

> There is a near-empty sibling at `/Users/akshmnd/Dev Projects/stellar` — **ignore it.**
> Note: a new shell may open in that sibling, so always `cd` into `stellar-benzo` first.

**Load secrets/config into every new shell** (`.env` lives at the repo root, gitignored):

```bash
set -a; . ./.env; set +a
```

---

## 1. Where the keys & secrets live

| What | Location | Notes |
|---|---|---|
| Network / asset / account env vars | `.env` (repo root, **gitignored**, present locally) | source of truth; load with the command above |
| Stellar CLI signing identities | `~/.config/stellar/identity/*.toml` | `benzo-deployer`, `benzo-relayer`, `benzo-anchor-dist`, `benzo-anchor-sign`, `benzo-e2e` |
| CLI wallet (your note spend/view keys) | `~/.benzo/account.json` | plaintext (AES-GCM if `BENZO_PASSPHRASE` set) |
| Durable note-sync state + journal | `~/.benzo/state.json` | FileKVStore; safe to delete to force a full re-sync |
| Live contract IDs | `deployments/testnet.json` (committed) | pool, verifier, merkle, nullifier_set, asp_membership, asp_non_membership, viewkey_anchor, handle_registry, request_registry, token (USDC SAC), usdcAsset |

Useful key commands:

```bash
stellar keys ls                       # list identities
stellar keys address benzo-deployer   # public key
stellar keys show    benzo-deployer   # reveal secret (if you need to inspect)
```

**`.env` variable names** (values already filled in locally): `STELLAR_NETWORK`,
`SOROBAN_RPC_URL`, `HORIZON_URL`, `FRIENDBOT_URL`, `NETWORK_PASSPHRASE`,
`USE_TEST_TOKEN`, `USDC_CODE`, `USDC_ISSUER`, `DEPLOYER_PUBLIC/SECRET`,
`RELAYER_PUBLIC/SECRET`, `ANCHOR_DISTRIBUTION_PUBLIC/SECRET`,
`ANCHOR_SIGNING_PUBLIC/SECRET`, `MERCURY_API_KEY`, `CIRCLE_API_KEY`, `GITHUB_TOKEN`.

---

## 2. Funding state (real testnet USDC)

- **USDC** is a real custom testnet asset: `USDC:GBBD47IF…FLA5` (`USE_TEST_TOKEN=false`,
  i.e. NOT a mock token). Soroban SAC: `CBIELTK6…DAMA`.
- **Deployer** `GBRMUZEL…BCMP` holds ≈ **0.2418 USDC** (public) and is the onboarding sponsor.
- **CLI wallet** already holds **0.25 USDC shielded** — so you can immediately
  `send` / `unshield` / `claim` / `prove-balance` without funding anything.
- **Relayer** `GD2U26BT…ZMT7` is the gas sponsor + relay submitter.

Balances are modest, so **use small denominations (0.05) for repeat tests.**
Top-ups: XLM via friendbot (`$FRIENDBOT_URL`); more test-USDC means re-funding the
deployer from the USDC issuer — not scripted, ask the owner if you exhaust it.

Check on-chain at any time:

```bash
node apps/cli/dist/index.js balance                       # shielded balance (syncs first)
stellar contract invoke --id "$(node -e "console.log(require('./deployments/testnet.json').token)")" \
  --source benzo-deployer --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" -- balance --id "$DEPLOYER_PUBLIC"
```

---

## 3. Prerequisites (already installed locally)

- Rust **1.93.1** + `wasm32v1-none` (pinned via `rust-toolchain.toml`)
- Stellar CLI **25+**
- Node **20** + pnpm **10**
- circom **2.2+**, snarkjs
- circomspect **0.9.0** (`~/.cargo/bin`) — optional, for circuit static analysis
- **Circuit proving artifacts** are gitignored but **present locally** at
  `circuits/build/{shield,joinsplit,unshield,proof_of_balance}/…` (`.wasm` + `.zkey`).
  These are **required** to produce proofs — don't delete them.

---

## 4. Build & verify (offline — no funds, no network writes)

```bash
cargo test  --workspace                 # 108 contract/lib tests pass
cargo clippy --workspace --all-targets  # 0 issues (lints deny unwrap/expect/unsafe)
stellar contract build                  # all Soroban wasms build
pnpm install && pnpm -r build && pnpm -r test   # 140 TS tests pass
pnpm lint                               # Biome clean
circomspect circuits/*.circom           # clean (report: audits/circomspect-report.txt)
```

---

## 5. Real testnet-USDC flows (CLI)

From the repo root, after loading `.env`. All commands are
`node apps/cli/dist/index.js <cmd>`.

**Inspect**
```bash
node apps/cli/dist/index.js address     # your shareable payment address
node apps/cli/dist/index.js balance     # sync + spendable USDC
node apps/cli/dist/index.js history
```

**Core money path (shield → private send → unshield)**
```bash
node apps/cli/dist/index.js shield   --amount 0.10
node apps/cli/dist/index.js send     --to @merchant --amount 0.05            # private transfer
node apps/cli/dist/index.js send     --to @merchant --amount 0.05 --relayer  # gasless (via relayer svc, §7)
node apps/cli/dist/index.js unshield --amount 0.05 --to GBRMUZEL…BCMP        # back to public USDC
```

**Handles** — `handle-register --handle NAME`, `handle-resolve --handle NAME`

**Claim links** (pay someone with no account)
```bash
node apps/cli/dist/index.js claim-create --amount 0.05            # prints a link
node apps/cli/dist/index.js claim-redeem --link <url> [--to G..]
```

**Requests / invoices** — `request create|pay|mark-paid|status|cancel|expire`
**Payroll** — `payroll --payouts "@a:10,@b:25"`, then `disclose-total`
**Compliance / disclosure** — `disclose` (auditor view-key + reconstructed flows), `prove-balance --min 0.2`
**Onboarding & ramps** — `onboard` (fresh account at 0 XLM + sponsored USDC trustline);
`cashin` / `cashout` / `onramp` (need the anchor running; **fiat legs are Mock**, see §8)

Run `node apps/cli/dist/index.js --help` for the full surface with flags.

---

## 6. End-to-end suites (settle real testnet USDC)

```bash
cd tests
node e2e/m1-flow.mjs         # shield → transfer → unshield
node e2e/m2-compliance.mjs   # MVK/TVK selective disclosure + both ASP gates
node e2e/m3-corridor.mjs     # SEP-24 corridor (fiat legs simulated)
```

---

## 7. Gasless money path (relayer + sponsor service)

```bash
RELAYER_PORT=8788 node packages/relayer/dist/server.js
#   GET  /health
#   POST /sponsor/onboard   (server co-signs only — never custodies)
#   POST /relay             (accepts only a proven `transfer`)
```

This is the gasless `/relay` path; `node apps/cli/dist/index.js send --relayer`
routes through it and settles real USDC. The same relayer/sponsor service backs
the console's gasless sends (via the `@benzo/core` seam in `apps/console-api`).

---

## 8. Read these for the security model

- `SECURITY.md` — threat model, actors/trust assumptions, invariants (value
  conservation, no-double-spend, **turnstile supply backstop**, fail-closed
  soundness), known attack surface, ceremony plan.
- `audits/circomspect-report.txt` — Trail of Bits' circomspect, clean on all
  production circuits.

---

## 9. Honest caveats — read before you judge scope

- **Testnet / self-host / sandbox only.** No mainnet, no partner-gated integrations.
- **Not externally audited.** In-repo hardening done; external audit (E2) is open.
- **Trusted setup is a single-machine simulation** (`scripts/ceremony.sh`, joinsplit
  transcript only) — not a real multi-party ceremony. Don't treat the zkeys as final.
- **Fiat on/off-ramp + KYC are Mock by design** — the corridor exercises the
  on-chain legs for real; fiat movement is simulated.
- **The deployed pool is built from source HEAD** — it includes the turnstile
  backstop (`pool.total_shielded`) AND the org M-of-N `transfer_org` entry, both
  unit-tested; `deployments/testnet.json` points at this redeploy.
- **`.env.example` covers all knobs** including the optional TEE prover + the
  local-dev escape hatches; it contains no secrets and is safe to publish.
- **Test counts** (run `cargo test --workspace` / `pnpm test:zk` for the live number):
  contracts ~157 Rust (pool 17 incl. `transfer_org` gate), TS core/kyc/etc.; the
  ZK proving tests only run when artifacts are present (see README → `pnpm test:zk`).
