# Benzo — private-by-default shielded-USDC payments on Stellar

**Benzo** is a private-by-default, shielded-USDC payments protocol on Stellar
(Soroban). Everyday stablecoin payments hide **both amount and counterparty**
through zero-knowledge shielded notes, while compliance — selective disclosure
via hierarchical viewing keys and Association-Set screening — is built into the
regulated edges.

> Built for **Stellar Hacks: Real-World ZK**. The ZK is load-bearing by
> construction: strip the proofs and there is no private payment — the pool
> verifies a Groth16 proof on Stellar's native BN254 host functions (CAP-0074)
> **before it will move a cent**, and admission verifies a credential proof
> on-chain before a depositor is allowed in.

## Demo

> **▶️ Demo video:** _(add link here)_ — shield → private transfer → unshield on
> Stellar testnet with real Circle testnet USDC: real Groth16 proofs accepted
> on-chain, a tampered proof rejected, viewing-key disclosure to an auditor.

Reproduce against the already-deployed testnet contracts (no redeploy):

```bash
pnpm install
bash scripts/fetch-artifacts.sh     # the exact zkeys/wasm that match the deployed VKs
bash scripts/setup-testnet-env.sh   # generate + friendbot-fund keys, write .env
cd tests && node e2e/m1-flow.mjs    # shield → private transfer → unshield (prints Stellar Expert links)
```

---

## What's real vs. simulated (read this first)

Benzo is an **honest work-in-progress**. This table is the source of truth; the
rest of the README is organized into the same three tiers (CORE / TOOLING /
FUTURE) so it's clear what is load-bearing on-chain today versus what is tested
but not yet wired, versus what is reference-only.

### CORE — ZK that gates real value/admission, verified on-chain (testnet)

| Component | Status |
|---|---|
| Groth16 proving (shield / joinsplit / unshield) | **Real** — headless snarkjs in Node; proofs verified on-chain by the BN254 verifier inside the `pool` entrypoints |
| BN254 Groth16 verification | **Real** — Soroban CAP-0074 host functions, on testnet |
| Poseidon2 commitments / nullifiers / Merkle | **Real** — CAP-0075 host function, byte-identical to circuit & SDK (asserted in tests) |
| USDC custody & settlement | **Real** — Circle testnet USDC (issuer `GBBD47IF…FLA5`) as a SAC, custodied by the pool |
| Shield / private transfer / unshield | **Real** — on testnet, with on-chain nullifiers, Merkle commitments, balance moves |
| ASP allow-membership (deposit) / proof-of-innocence (withdraw) | **Real** — enforced in-circuit + against live on-chain registry roots |
| Tiered KYC admission (`kyc_credential`) | **Real** — `KYC` vk on the verifier; `asp_membership.admit_by_proof` verifies the credential proof on-chain and enforces tier + `issuer_registry` membership |
| MVK→TVK viewing-key disclosure | **Real** — HKDF derivation, X25519+AES-GCM, reconstructed from on-chain ciphertext |
| Org M-of-N dual-control (`joinsplit_org` / `pool.transfer_org`) | **Real** — org funds live in notes bound to the org's member-set root + threshold; the pool's `transfer_org` entry only settles a spend carrying a valid in-circuit M-of-N proof (`JSPLITORG` vk), and **rejects a single-key consumer proof** of org funds. VK-gate proven by the pool unit test `transfer_org_settles_under_jsplitorg_vk_and_is_vk_gated`. |
| Fiat on/off-ramp reserve (`ramp`) | **Real USDC leg** — an on-chain reserve (MoneyGram/SEP-24-anchor-modeled) dispenses/absorbs real Circle testnet USDC on cash-in/out; idempotent per-tx ref + published caps. Only the *fiat charge/payout* is simulated. |
| On-chain KYB attestation (`org_account.attest_kyb`) | **Real** — the KYB decision is posted on-chain by a designated issuer key (issuer-gated) and read back from chain; replaces the former BFF mock. The issuer key is the provider-integration seam. |

### TOOLING — real, supports the core (not itself a money-path proof)

| Component | Status |
|---|---|
| `BenzoClient` SDK + `@benzo/cli` | **Real** — drive create/shield/send/unshield/disclose/admit end-to-end on testnet; the CLI is the e2e harness |
| Gasless relayer | **Real** — non-custodial; submits proven transfers, paid in USDC out of the pool |
| Note-discovery indexer | **Real** — scans Soroban events, view-tag fast path, viewing-key scan API (self-hosted) |
| SEP-1 / SEP-10 / SEP-24 anchor | **Real wire protocol** — self-hosted; real Ed25519 SEP-10; real on-chain USDC settlement at both edges |
| Confidential TEE prover (Phala dstack / Intel TDX) | **Real** — in-enclave snarkjs prover; client verifies the live TDX attestation quote (dcap-qvl), seals the witness to the attested key, and the enclave-produced proof verifies on-chain. _TEE adds witness confidentiality; soundness still rests on the on-chain proof._ |

### Verifiable on-chain, but NOT yet gating an action (tested, VK registered)

| Component | Status |
|---|---|
| Proof-of-funds (`funds_attestation`) | **VK registered (`FUNDS`); `verify_proof` returns `true` on testnet** — but oracle-backed (an EdDSA oracle signs the balance) and **not wired into any business entrypoint** yet. Soundness here rests on the oracle, not pure ZK. |
| Disclose-total (`proof_of_sum`, `proveTotal()`) | **VK registered (`SUM`)** — ZK proof of a payroll/invoice total without revealing line items. Exposed via the SDK; a plaintext `disclosedTotal()` convenience also exists alongside it. |

### FUTURE / REFERENCE — not on-chain in this repo

| Component | Status |
|---|---|
| Note-based proof-of-balance (`proof_of_balance`) | Circuit + `benzo prove-balance` exist, **but there is NO on-chain verifier for it** — the proof is generated/verified off-chain only. (For the on-chain proof-of-funds, see `funds_attestation` above.) |
| Track B — Noir → UltraHonk | **Reference only.** Verified **locally** against the vendored harness in `reference/code/rs-soroban-ultrahonk`; **not deployed by this repo** (no Noir circuit or verifier in the tree, no entry in `deployments/testnet.json`). Treat it as an exploration, not an on-chain claim. |
| B2B console (web UI) | **Built** — `apps/console` is a working web console (onboarding, treasury, payroll, invoices, approvals/policies, roles, auditor grants) over the real `apps/console-api` BFF. |
| KYC providers / on-ramp / CCTP / commercial anchors | **Mock / sandbox** — env-keyed adapters behind stable interfaces; see [Scope](#scope-sandbox-now). |
| **Fiat (bank/cash) ledger leg** | **SIMULATED** — the self-hosted anchor credits "fiat received"/"paid out" with no real bank, driven via `POST /sep24/sim/:id`. This is the only simulated *protocol* piece. |

No mainnet keys are used anywhere. Testnet-only, unaudited. `.env` and `reference/` are gitignored.

---

## How the ZK maps to the hackathon prompts

Honest markers: **[on-chain]** = a proof is verified by a Stellar contract today;
**[off-chain]** = real circuit/proof but no on-chain verifier yet; **[ref]** = reference only.

- **Shielded transfer / private payment** (🟡) **[on-chain]** — the core 2-in/2-out join-split; amounts + counterparties hidden.
- **Compliant privacy pool with ASP** (🟠) **[on-chain]** — allow-membership at deposit + proof-of-innocence non-membership at withdraw.
- **Private credential / tiered KYC** (🟡) **[on-chain]** — `kyc_credential` proof gates admission with an issuer-signed assurance tier.
- **Compliant transfer with a view key** (🟡) **[on-chain]** — MVK→TVK scoped, expiring, revocable selective disclosure.
- **Confidential payroll / disclose-total** (🟡) **[on-chain vk]** — `proof_of_sum` proves a total to an auditor without revealing line items (`SUM` vk registered).
- **Proof-of-funds** (🟢) **[on-chain vk]** — `funds_attestation` proves balance ≥ X (oracle-backed; `FUNDS` vk registered, `verify_proof` true on testnet).
- **Private cross-border remittance corridor** (🔴) **[on-chain + simulated fiat]** — fiat-in → shield → private send → unshield → fiat-out (fiat leg simulated).
- **UTXO-style private payments** (🔴) **[on-chain]** — the shielded-note model itself.
- **Verifiable off-chain computation** (🟢) **[ref]** — Track B (Noir) verified locally, not deployed here.

---

## Architecture

Three planes: a **client plane** that holds keys and proves (the headless
`@benzo/core`, or the attested TEE prover), an **on-chain plane** of Soroban
contracts that verify proofs and mutate state, and an **off-chain services
plane** that indexes encrypted notes, sponsors fees, and bridges fiat.

```
                       ┌──────────────────── on-chain (Soroban, testnet) ─────────────────────┐
  @benzo/core          │   pool ──verify──► verifier_groth16  (BN254 / CAP-0074)               │
  (headless prover)    │    │                  ▲  KYC / SHIELD / TRANSFER / UNSHIELD / SUM/FUNDS│
   or PhalaProver ────►│    ├─ insert ─► merkle            (Poseidon2 tree, CAP-0075)          │
   (attested TEE)      │    ├─ spend  ─► nullifier_set      (persistent, idempotent)           │
   shield/transfer/    │    ├─ check  ─► asp_membership ──► admit_by_proof (tiered KYC gate)    │
   unshield + proof    │    │                └─► issuer_registry (authorized credential issuers)│
                       │    ├─ check  ─► asp_non_membership (deny-SMT, proof-of-innocence)      │
                       │    └─ bind   ─► viewkey_anchor / mvk_registry (MVK→TVK disclosure)     │
                       └────────────────────────────────────────────────────────────────────────┘
        ▲                         │ events (commitments, ciphertexts, nullifiers)
        │ gasless submit          ▼
  @benzo/relayer            @benzo/indexer ──viewing-key scan──► holders & auditors
        ▲
        │ fiat edges (SEP-10 JWT + SEP-24; USDC settled on-chain, fiat SIMULATED)
  @benzo/anchor
```

### Canonical cryptographic invariants (normative)

- **Commitment** `= Poseidon2(amount, recipient_pk, blinding, asset_id)`
- **Nullifier** `= Poseidon2(spend_sk, leaf_index, NULLIFIER_DOMAIN)`
- **Merkle node** `= Poseidon2(left, right)`; tree `DEPTH = 32`, `ROOT_HISTORY = 128`
- **Proof** Groth16 over BN254, one constant-size multi-pairing check
- **Poseidon2 byte-identical** across the circom circuit, the `@benzo/core` TS
  mirror, and the Soroban host function — pinned in
  [`circuits/poseidon_params/poseidon2_bn254.json`](circuits/poseidon_params/poseidon2_bn254.json)
  and asserted against the on-chain zero table in tests.
- **Nullifiers in persistent storage only**; idempotent "already spent = success".
- **Field-element encoding fails loud** — out-of-range values are rejected, never
  silently truncated, before any proof/VK byte hits the chain.

---

## Repository layout

A **pnpm + Turborepo monorepo** — one headless core, many surfaces.

```
packages/
  core/         @benzo/core — headless protocol SDK: notes, Poseidon2, Merkle
                mirror, prover (Node/WASM/attested-TEE), viewkeys, scanner,
                attestation verifier, contract clients, the BenzoClient facade
  proving-artifacts/  artifact cache + prover router (on-device vs TEE)
  links/        @benzo/links — typed BenzoLink union (claim/request/handle)
  indexer/      @benzo/indexer — note-discovery indexer (view-tag fast path)
  relayer/      @benzo/relayer — gasless, non-custodial submitter
  anchor/       @benzo/anchor — self-hosted SEP-1/10/24 corridor edges
  kyc/          @benzo/kyc — tiered identity (AssuranceTier), CredentialIssuer,
                Self.xyz + zkLogin providers (Mock default for the demo)
  attest/       @benzo/attest — AttestProtocol (Stellar attestation) wrapper
  plaid/        @benzo/plaid — Plaid sandbox client (balance + ACH transfer)
  integrations/ @benzo/integrations — corridor edges (screening/on-ramp/CCTP)
  connectors/   @benzo/connectors — accounting/HRIS/bank sandbox clients
  types/        @benzo/types — shared B2B domain model + console↔BFF contract
apps/
  wallet/       @benzo/wallet — consumer wallet web app (shield/send/cash/requests)
  wallet-api/   @benzo/wallet-api — consumer BFF (real on-chain via @benzo/core)
  console/      @benzo/console — B2B console web app (treasury/payroll/approvals/KYB)
  console-api/  @benzo/console-api — the console BFF (real; @benzo/core seam)
  cli/          @benzo/cli — FULLY BUILT; every protocol op as a command + e2e harness
services/
  prover-enclave/  in-enclave snarkjs prover + TDX quote endpoint (Phala dstack)
contracts/      16 Soroban (Rust) contracts: pool, verifier_groth16, merkle,
                nullifier_set, asp_membership, asp_non_membership, viewkey_anchor,
                mvk_registry, issuer_registry, identity_nullifier_set,
                handle_registry, request_registry, org_account, ramp, escrow
                (+ common: shared soroban-utils incl. the Poseidon2 host wrapper)
circuits/       Circom (Poseidon2 + circomlib + SMT): shield / joinsplit / unshield
                / kyc_credential / funds_attestation / proof_of_sum / proof_of_balance
                / joinsplit_org (in-circuit M-of-N) / org_spend_auth / trivial
ceremony/       Phase-2 trusted-setup driver + transcripts (joinsplit, kyc, funds)
deployments/    per-network contract ids (testnet.json) + the live TEE endpoint
reference/      vendored study repos (gitignored): stellar-private-payments,
                rs-soroban-ultrahonk, soroban-examples, …
```

---

## Quickstart

### Prerequisites
- Rust (pinned via `rust-toolchain.toml`) + `wasm32v1-none`, Stellar CLI 25+
- Node 20 + pnpm 10
- For circuits: `circom` 2.2+, `snarkjs`
- **Network protocol ≥ 25** — the verifier and merkle contracts depend on the
  BN254 (CAP-0074) and Poseidon2 (CAP-0075) host functions (`deploy-testnet.sh`
  preflights this and aborts otherwise).

### Build the ZK artifacts first (required to run any proof)
The compiled circuits (`.zkey`/`.wasm`, ~100 MB) are **gitignored**. Pick one:

```bash
# A) Build from source — compiles every circuit + Groth16 setup (deploy your OWN contracts).
bash scripts/build-artifacts.sh           # or: pnpm build:artifacts

# B) Fetch the EXACT published artifacts (to transact against the DEPLOYED Benzo testnet).
bash scripts/fetch-artifacts.sh           # verifies sha256 vs circuits/build/artifacts-manifest.json
```
Groth16 keys are setup-specific: a fresh build (A) produces fresh VKs, so its
proofs verify against a verifier **you** deploy (`scripts/deploy-testnet.sh`); to
use the already-deployed contracts, use (B). `node scripts/check-artifacts.mjs`
reports which artifacts are present.

### Build & test
```bash
cargo test --workspace        # contract tests (Rust)
cargo clippy --workspace --all-targets -- -D warnings
stellar contract build        # all contracts -> wasm32v1-none

pnpm install
pnpm -r build                 # all @benzo/* packages + apps
pnpm test                     # unit tests (proving tests SELF-SKIP if artifacts absent)
pnpm test:zk                  # same, but HARD-FAILS if ZK artifacts are missing
```
> **Honest-green:** the heavy snarkjs proving tests `describe.skipIf` when the
> gitignored `.zkey`/`.wasm` are absent — so a plain `pnpm test` can pass *without
> exercising a single proof*. Use **`pnpm test:zk`** (it runs `check-artifacts.mjs`
> first) to guarantee the proofs actually run. The committed VK/proof fixtures
> always enforce the snarkjs→Soroban byte-identity invariant regardless.

### Run the demo against testnet (no redeploy)
```bash
bash scripts/setup-testnet-env.sh     # generate + fund keys, write .env
cd tests
node e2e/m1-flow.mjs                   # shield → private transfer → unshield
node e2e/m2-compliance.mjs            # MVK/TVK disclosure + ASP both gates
node e2e/m3-corridor.mjs             # SEP-24 corridor: fiat-sim → … → fiat-sim
node e2e/admission.mjs               # tiered-KYC admission proof, on-chain
```

To redeploy fresh: `set -a; . ./.env; set +a; bash scripts/deploy-testnet.sh`.

### The SDK a frontend calls
A frontend uses ONLY `BenzoClient` from `@benzo/core`. `send()` is non-blocking
(returns a `SendHandle` reporting `pending → proving → settled`). Note keys derive
from **one wallet signature** (`loginWithSigner`) — no second seed phrase — and
onboarding can be **zero-XLM** via sponsored reserves (CAP-33). Full surface in
[`packages/core/src/client.ts`](packages/core/src/client.ts).

---

## Compliance model — "open by default, private when needed, compliant"

- **Privacy in the middle.** `transfer` is a 2-in/2-out join-split; amounts and
  the sender↔recipient link are hidden. No SAC movement.
- **Identity at the edges.** `shield` requires an **ASP allow-membership** proof
  (depositor bound in-circuit to a KYC'd allow-set leaf), and admission can be
  gated by a **tiered `kyc_credential` proof** verified on-chain. `withdraw`
  requires an **ASP non-membership / proof-of-innocence** proof against the deny
  sparse-Merkle tree — mandatory at exit, checked against the live deny-root.
- **Guaranteed auditability.** Every note carries an MVK tag
  `Poseidon2(mvk_pub, blinding)`; a scoped **TVK** (one-way HKDF from the MVK)
  lets an auditor passively reconstruct exactly the in-scope notes from on-chain
  ciphertext — and nothing else. Viewing keys are decrypt-only; never spend.

### Auditor lifecycle & trust assumptions

- **In-circuit (trustless):** the MVK tag, ASP allow-membership at deposit, ASP
  non-membership at withdraw, and the `kyc_credential` tier/issuer binding are all
  proven in-circuit against live on-chain roots — no party is trusted for these.
- **Off-circuit (trusted):** MVK-ciphertext payload integrity, ASP curation (who
  is in the allow/deny sets), the credential issuer set, and the
  `funds_attestation` oracle are operator responsibilities, not circuit-enforced.
- **TVK grants are scoped, expiring, and revocable** (`viewkey_anchor`); a
  leaked/offboarded auditor key only ever exposes its own in-scope notes.
- **Honest users always exit.** The normal private `withdraw` *is* the always-exit
  path: the deny-SMT default-excludes everyone, so proof-of-innocence succeeds for
  any honest note. **Trust caveat:** the deny-set admin is a trusted party — it can
  freeze a flagged commitment (reversible, admin-gated, event-observable) and
  **must** be a multisig/timelock in any real deployment.

### Security & threat model (summary)

- **Soundness:** the pool fails closed — a non-verifying proof returns
  `Err(InvalidProof)`; the verifier validates VK structure at registration and
  rejects tampered/cross-circuit/wrong-input proofs (negative-tested). VKs are
  immutable per circuit id by design.
- **No double-spend / no duplicate leaves:** per-entry persistent nullifiers
  (idempotent replays); the Merkle contract rejects replayed commitments.
- **Anti-malleability:** transfer/withdraw bind a relayer/fee/recipient
  `ext_data_hash` in-circuit, so a relayer cannot alter a proven transaction.
- **TEE boundary:** the attested-prover path adds witness *confidentiality* only;
  the on-chain proof is the sole soundness anchor, so a compromised enclave can
  never mint or double-spend.
- **State durability (CAP-0078):** long-lived persistent entries proactively
  extend TTL on the hot path.
- **Keys:** spend / master-viewing / note-discovery authorities are separated;
  viewing keys never carry spend authority; testnet-only, no mainnet keys.
- **Statically clean both sides:** the Soroban contracts are **Scout (CoinFabrik)
  clean — 0 findings across all 16 crates** ([audits/scout-report.txt](audits/scout-report.txt),
  also a CI job) and the circom circuits are **Circomspect (Trail of Bits) clean**
  ([audits/circomspect-report.txt](audits/circomspect-report.txt)).
- **Soundness invariants are property-tested:** randomized `proptest` cases (real
  Groth16 per case) cover value conservation, the turnstile supply backstop
  (`TotalShielded` never over-withdrawn), and nullifier no-double-spend, plus
  negative tests for non-canonical inputs and wrong/tampered proofs.
- **Capability-gated:** the BN254/Poseidon2 host functions are Protocol-25+ only;
  deploy preflights the network version and aborts if too old — see
  [docs/CAPABILITY-MATRIX.md](docs/CAPABILITY-MATRIX.md).
- **Architecture:** a clean verifier-gateway / policy / application split — a
  stateless per-circuit Groth16 verifier (`verifier_groth16`), compliance policy
  (ASP allow/deny + issuer/MVK registries), and the pool's state transition, with
  proof verification preceding every state mutation (fail-closed).

Benzo forks Nethermind's **stellar-private-payments** (ASP contracts, Poseidon2
host wrappers, Groth16 verifier shape — Apache-2.0) and the canonical
`soroban-examples/groth16_verifier`; circuits build on the tornado-nova join-split
shape, re-expressed over Poseidon2 with Benzo's note model and compliance gates.
Trusted setup is a **single-machine Phase-2 simulation** (driver + transcript in
`ceremony/`, joinsplit only) — the testnet contracts run these non-production VKs;
**a real multi-party ceremony is required before mainnet.**

---

## Scope (sandbox now)

The hackathon corridor runs **100% on testnet with zero external accounts**: Mock
KYC by default (no real PII), the self-hosted anchor for cash in/out, and
Mock/keyless everything else. The commercial edges are real, env-keyed adapters
behind the same interfaces, kept as clearly-labeled **FUTURE** integration points
that require the provider's own account to activate — they are **not** used in the
demo and imply no partnership:

- **Identity:** Self.xyz, zkLogin, AttestProtocol, and a `CredentialIssuer` exist
  in `@benzo/kyc`/`@benzo/attest` (injected/sandbox in tests). Mock until keyed.
- **On-ramp / rails:** Stripe Crypto (sandbox), Plaid (sandbox), Circle CCTP,
  MoneyGram/Alfred SEP-24 anchors — flip the env key to go live, no protocol change.

**Status:** testnet, unaudited. Not for production or real funds.
