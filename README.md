# Benzo

Private USDC payments on Stellar, with the proof doing the work.

Benzo is a consumer wallet and business console for shielded USDC on Stellar
testnet. Users can add money, move it into a private balance, send privately by
handle, send publicly to a Stellar address, cash out, request money, invite a new
recipient, and share proofs. Businesses get a treasury console for confidential
payroll, invoices, approvals, grants, private audit packets, and proof-of-reserves
style attestations.

The important part: the private money path is not a mocked UI. The Soroban
contracts verify Groth16 proofs with Stellar's BN254 host functions before value
moves in or out of the pool. Amounts and counterparties stay out of public chain
state; nullifiers, commitments, roots, and proof verification stay public.

Built for **Stellar Hacks: Real-World ZK**.

## Open this first

| Surface | URL | What to try |
|---|---|---|
| Wallet | [wallet.benzo.space](https://wallet.benzo.space) | Sign in, claim a handle, add money, make private, send, request, cash out, share a proof |
| Console | [console.benzo.space](https://console.benzo.space) | Google sign-in, treasury, contractors, payroll, invoices, approvals, grants, audit log |
| Verifier contract | [CCBR2Y3Z...XYB](https://stellar.expert/explorer/testnet/contract/CCBR2Y3ZAD75UFLZSED3NJYZDYIYZIGIEMZO6BQ45Y2NQBWPJ7MXKXYB) | 16 live verification keys |
| Privacy pool | [CB4VS4OC...JOT](https://stellar.expert/explorer/testnet/contract/CB4VS4OCF6HEGCLSPM4E3ILNGP4KF5ZJ7JEXUJIJBUU5IZC2VPDVSJOT) | Shield, transfer, unshield, org transfer |
| Deployment record | [deployments/testnet.json](deployments/testnet.json) | Contract IDs, VK names, tx provenance, TEE endpoint |

Network: Stellar testnet. Asset: real Circle testnet USDC. Status: unaudited
hackathon build, not mainnet software.

## What we built

Benzo combines three products into one working testnet system.

**Consumer wallet**

- Google sign-in or device passkey onboarding.
- Device-bound account derivation. No seed phrase in the UI.
- Private balance and public balance.
- Add money from the ramp reserve into the private pool.
- Cash out from private balance back to the ramp reserve.
- Make public and make private.
- Private send to `@handle`.
- Public send to any valid Stellar `G...` address.
- Deposit/import external USDC.
- Money request links and invite links.
- Contacts, receipts, on-chain details, explorer links, proof sharing.
- Security lock using platform passkeys. On Apple this may be Face ID or Touch ID;
  on Windows this may be Windows Hello PIN, face, fingerprint, or a security key;
  on Android this may be the device passkey prompt, screen lock, PIN, or pattern.
  If WebAuthn/passkeys are unavailable, lock toggles are disabled so users are not
  trapped.

**Business console**

- Google sign-in verified through the hosted console path.
- Desktop-only console shell with workspace nav, command bar, notifications, and
  approvals.
- Treasury with private and public balances, receive QR, public send, make private,
  proof of reserves, solvency proof, and on-chain details.
- Contractors, CSV import, rate cards, payment history, and payroll runs.
- Payroll checks for policy, anonymous approval, computation, and funding.
- Invoices, single pay, pay all, and private netting.
- Grants and scoped viewing-key style auditor access.
- Private audit packets: encrypted client events, hash chain, Merkle packet,
  downloadable packet, and on-chain root anchor.

**Protocol and infrastructure**

- Soroban contracts for the verifier, pool, Merkle tree, nullifier set, ASP
  membership and non-membership, handle registry, request registry, ramp,
  org account, MVK registry, viewing-key anchor, audit root, issuer registry, and
  identity nullifier set.
- `@benzo/core`, a headless TypeScript SDK for proving, note scanning, shield,
  transfer, unshield, org transfer, viewing keys, and relayed writes.
- Browser proving for capable desktops.
- Phala dstack / Intel TDX proving for mobile, weak devices, and the console path.
- Serverless wallet and console APIs that fail closed when live chain config,
  encrypted storage, or auth config is missing. No demo fallback is accepted in
  production.
- Neon-backed encrypted tenant storage for hosted state. The database stores
  ciphertext documents only; wallet state is keyed by auth identity, console
  state is keyed by org identity, and new tenants start empty.
- CI gates for packages, contracts, Poseidon2 parameter parity, stale deployment
  addresses, and real proving artifacts when available.

## The ZK is load-bearing

The hackathon asks for ZK that matters. In Benzo, removing the proof breaks the
payment path.

| User action | Circuit / proof | On-chain gate |
|---|---|---|
| Add money / shield | `SHIELD` | Deposit becomes a note only if the proof verifies |
| Private send | `TRANSFER` | Nullifiers are spent and new commitments inserted only after proof verification |
| Make public / cash out | `UNSHIELD` | Note burn and public USDC release require proof verification |
| Business private payout | `JSPLITORG` | Org notes move only with in-circuit M-of-N approval proof |
| KYC admission | `KYC` | Admission checks issuer, tier, freshness, and identity nullifier |
| Proof of balance | `BALANCE`, `ORGBAL` | Proves a threshold or funding statement without showing balances |
| Period total / auditor proof | `SUM`, `ORGSUM` | Proves a disclosed total without revealing line items |
| Payroll computation | `PAYCOMP` | Proves the run total came from the rate card |
| Spending policy | `SPENDCAP` | Proves a payout is within an approved cap |
| Compliance screening | `POIPAYOUT` | Proves a recipient is not in the deny set |
| KYB | `KYB` | Proves a business credential without revealing underlying docs |
| Private netting | `NETTING` | Proves the net amount between parties while hiding gross lines |

The verifier has these 16 verification keys live on testnet:

`SHIELD`, `TRANSFER`, `UNSHIELD`, `SUM`, `KYC`, `FUNDS`, `BALANCE`,
`ORGAUTH`, `JSPLITORG`, `ORGSUM`, `ORGBAL`, `SPENDCAP`, `POIPAYOUT`,
`PAYCOMP`, `KYB`, `NETTING`.

Seven business-ZK keys were re-registered on the live verifier on 2026-06-23.
Their tx hashes are in [deployments/testnet.json](deployments/testnet.json)
under `provenance.vkRegistrations`.

## How privacy and auditability coexist

The public chain sees commitments, nullifiers, Merkle roots, verification key IDs,
and successful proof checks. It does not see the private amount, recipient handle,
invoice line, salary, approver comment, or business memo.

The private records needed for a real business workflow are encrypted before
they become hosted state:

- Hosted wallet and console APIs persist tenant documents in Neon as AES-GCM
  ciphertext. The database row key identifies the tenant document, not the
  contents inside it.
- Wallet documents are scoped to the authenticated user. Console documents are
  scoped to the authenticated org/workspace. A fresh Google or passkey account
  starts with zero balance, empty contacts, empty activity, and no seeded console
  objects.
- Console private events are stored as encrypted envelopes. Each envelope
  commits to the previous one, so the packet is tamper-evident.
- Private audit packets include ciphertext records, hash-chain head, Merkle
  root, inclusion proofs, and linked on-chain proof/payment refs.
- The console anchors only packet/root metadata to `audit_root`.
- A scoped auditor can receive the packet and verify integrity without the chain
  learning payroll or invoice details.

Hosted operational state is tenant-persistent too: invites, onboarding,
private-event envelopes, proof receipts, idempotency records, and rate-limit
buckets survive serverless cold starts. Write endpoints accept `Idempotency-Key`;
the same key and same body replay the original JSON result, while the same key
with a different body fails with `409`.

This is the product line Benzo is exploring: keep payment and business data
private by default, but make selected facts provable when a counterparty,
auditor, lender, or regulator needs confidence.

## Proving model

Benzo has two proving locations.

| Device / surface | Proving path |
|---|---|
| Capable desktop wallet | Browser WASM proving on the user's machine |
| Mobile wallet or weak device | Attested TEE proving through Phala dstack / Intel TDX |
| Business console | Attested TEE proving |
| API-mediated ramp / convert flows | TEE by default in hosted serverless |

The TEE path is witness-hiding, not a replacement for ZK soundness. The proof is
still verified on-chain. The enclave matters because it lets lower-power clients
prove without sending witnesses to an ordinary backend. The browser and console
pin the TEE compose hash from [deployments/testnet.json](deployments/testnet.json)
before sealing witnesses to the enclave key.

## Batched verification

Benzo also implements batched Groth16 verification for same-VK proofs. Instead of
one pairing check per proof, `verify_batch` folds N proofs into one randomized
linear-combination transcript inside the contract.

Practical result on testnet:

- `verify_batch` alone fits about 16 same-VK proofs per transaction.
- `insert_leaves` can insert about 200 leaves with subtree merging.
- The integrated `batch_transfer_org` path is settlement-bound at about 3 org
  spends per transaction because it also writes nullifiers, viewing-key bindings,
  and Merkle leaves.

That is batched verification, not recursion. It gives a real bounded win without
claiming thousands of payments per proof.

## Reproduce the proof check in 30 seconds

This does not need private keys, funded accounts, or proving artifacts. It replays
a real committed proof fixture against the live verifier and checks that a forged
public value fails.

```bash
pnpm install
node tests/replay-verify.mjs
```

Expected shape:

```text
verify_proof(ORGSUM) over the real total => true
verify_proof(ORGSUM) over a forged total => false
```

## Run the full testnet money flow

For the full shield, private transfer, and unshield path you need funded testnet
keys and the exact proving artifacts.

```bash
bash scripts/setup-testnet-env.sh
bash scripts/fetch-artifacts.sh
set -a; . ./.env; set +a
node tests/e2e/m1-flow.mjs
```

The e2e script prints transaction hashes and Stellar Expert links. Do not use
mainnet keys. `.env`, proving keys, and Powers of Tau files are intentionally
gitignored.

More focused live checks:

```bash
node tests/e2e/tee-onchain.mjs
node tests/e2e/joinsplit-org-settle-onchain.mjs
node tests/e2e/payroll-computation-onchain.mjs
node tests/e2e/cross-netting-onchain.mjs
node tests/e2e/kyb-credential-onchain.mjs
```

## Honest status

This section is intentionally blunt.

| Area | Status |
|---|---|
| Shield, private transfer, unshield | Real on Stellar testnet with real Circle testnet USDC |
| Groth16 verification | Real on-chain BN254 verification through Stellar host functions |
| Poseidon2 commitments and nullifiers | Real, with parity guards across circuit, SDK, and host parameters |
| Nullifier storage | Persistent contract storage |
| Org M-of-N spend | Real money path through `pool.transfer_org` and `JSPLITORG` |
| TEE proving | Live Phala dstack / Intel TDX endpoint, pinned by compose hash |
| Wallet and console UI | Live Vercel apps connected to live APIs |
| Hosted tenant storage | Neon-backed encrypted tenant documents, scoped per user or org |
| Hosted idempotency | Tenant-persistent `Idempotency-Key` records for write APIs |
| Hosted rate limits | Tenant-persistent rate buckets, not process memory |
| Proof receipts | Hosted APIs persist proof receipts with verifier/key metadata where the UI requests proof artifacts |
| Wallet reserve accounting | Add money, cash out, import, make public, public/private sends, and invite settlement append hash-chained tenant ledger entries with derived balances and failed-attempt records |
| Fiat/cash partner leg | Simulated testnet anchor leg. The USDC reserve moves on-chain; no real bank, MoneyGram, Stripe, or cash payout happens |
| Connector data | CSV and sandbox connectors. Real integrations are env-keyed future work |
| Mainnet | Not deployed |
| Audit | Not audited |

Known limits:

- Admin governance is still a single deployer key. Mainnet needs Stellar multisig
  and a timelock-style VK rotation process.
- Privacy improves with anonymity-set size. A fresh testnet pool is small.
- `proof_of_sum` proves the disclosed notes sum to a total. It does not prove the
  holder did not omit another note unless the authorized viewing-key set is
  complete.
- `FUNDS` is oracle-backed and should be read as proof of a signed balance claim,
  not pure note ownership.
- Hosted storage is encrypted document-per-tenant storage. Wallet reserve
  movements and console payments are hash-chained and auditable inside the
  tenant document, but mainnet should still split reserve accounting, audit
  events, proof receipts, and product objects into normalized tables with
  migration tooling.
- Reserve accounting now records the on-chain testnet reserve flow, derived
  balances, and failed attempts. Mainnet still needs reconciliation jobs and
  settlement failure operations before any real fiat partner is connected.
- Account recovery is deterministic today: Google/passkey identity plus the
  deployed account salt derives the hosted account. If the Google account,
  passkey, or salt changes, recovery must be handled by an explicit migration or
  support flow. That flow is not a self-serve product screen yet.

## Repository map

```text
apps/
  wallet/        Consumer wallet UI
  console/       Business treasury/payroll console
  wallet-api/    Serverless live wallet API, fail-closed
  console-api/   Serverless live console API, fail-closed
  landing/       Product entry page
  cli/           Operator/developer CLI

contracts/
  verifier_groth16/   BN254 Groth16 verifier and batch verifier
  pool/               Shield, transfer, unshield, org transfer
  merkle/             Poseidon2 Merkle tree
  nullifier_set/      Persistent nullifier registry
  asp_membership/     Allow-set membership and KYC admission
  asp_non_membership/ Deny-set non-membership
  org_account/        Org member roots and approval policy checks
  viewkey_anchor/     Viewing-key binding events
  audit_root/         Private audit packet root anchors
  handle_registry/    @handle registry
  ramp/               Testnet reserve/ramp contract

circuits/
  groth16/            Circom circuits
  poseidon_params/    Poseidon2 params used by circuits and SDK
  build/              Artifact manifest and local proving build outputs

packages/
  core/               Headless client SDK, prover ports, scanner, TEE routing
  private-events/     Client-encrypted console audit envelopes
  relayer/            Gasless submit service
  indexer/            Commitment/event indexing helpers
  anchor/             Self-hosted SEP-style testnet anchor pieces
  types/              Shared API/domain types

tests/
  replay-verify.mjs   Keyless proof replay against live verifier
  e2e/                Live testnet protocol flows
  live/               UI/live smoke scripts

deployments/
  testnet.json        Source of truth for live contract IDs, VKs, TEE config
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Contracts:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
stellar contract build
```

Wallet:

```bash
pnpm --filter @benzo/wallet-app typecheck
pnpm --filter @benzo/wallet-app test
pnpm --filter @benzo/wallet-app build
```

Console:

```bash
pnpm --filter @benzo/console typecheck
pnpm --filter @benzo/console test
pnpm --filter @benzo/console build
```

CI mirrors these checks and adds the Poseidon2 parity guard plus an opt-in real
proving gate when artifact hosting is configured.

## Stack

Stellar testnet, Soroban Rust contracts, BN254 host functions, Poseidon2 host
hashing, Circom, snarkjs, Groth16, TypeScript, React, Vite, Vercel serverless,
Phala dstack / Intel TDX, and `@stellar/stellar-sdk`.

## Judge checklist

- ZK is integrated with Stellar smart contracts: yes, proof verification happens
  in Soroban contracts on Stellar testnet.
- ZK is load-bearing: yes, shielded value movement and org transfers fail without
  valid proofs.
- Real-world use case: private stablecoin wallet, business payroll/invoices,
  cross-border style ramp corridor, and audit/compliance proofs.
- Demoable app: yes, wallet and console are live.
- Honest README: yes, simulated fiat partner leg and other limits are listed.
