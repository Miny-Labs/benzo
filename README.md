# Benzo

**Private-by-default shielded-USDC payments on Stellar — where the zero-knowledge proof, not a trusted server, is what moves the money.**

Benzo is a confidential payments protocol on Stellar (Soroban). Everyday stablecoin
payments hide **both the amount and the counterparty** through zero-knowledge
shielded notes, while compliance — selective disclosure via hierarchical viewing
keys, Association-Set screening, and tiered KYC — is built into the regulated edges.

> Built for **Stellar Hacks: Real-World ZK**. The ZK is **load-bearing by
> construction**: strip the proofs and there is no private payment. The pool
> verifies a Groth16 proof on Stellar's native BN254 host functions (CAP-0074)
> **before it moves a cent**, and admission verifies a credential proof on-chain
> **before a depositor is let in**. Sixteen verification keys are live on testnet.

**Live verifier:** [`CCBR2Y3Z…XYB`](https://stellar.expert/explorer/testnet/contract/CCBR2Y3ZAD75UFLZSED3NJYZDYIYZIGIEMZO6BQ45Y2NQBWPJ7MXKXYB)
· **Pool:** [`CB4VS4OC…JOT`](https://stellar.expert/explorer/testnet/contract/CB4VS4OCF6HEGCLSPM4E3ILNGP4KF5ZJ7JEXUJIJBUU5IZC2VPDVSJOT)
· **Network:** Stellar testnet · real Circle testnet USDC · **unaudited**

---

## Reproduce the ZK in 30 seconds (no keys, no funds, no artifacts)

The fastest way to see the zero-knowledge doing real work: re-verify a **real,
committed Groth16 proof** against the live verifier on Stellar, and watch the
chain reject a tampered one. It funds a throwaway account from friendbot (free)
just to source a read-only simulation — nothing is ever submitted or spent.

```bash
pnpm install
node tests/replay-verify.mjs
```

```
verify_proof(ORGSUM) over the real total  => true
verify_proof(ORGSUM) over a forged total  => false   (must be false)
✅ A real Groth16 proof verifies on Stellar (BN254 / CAP-0074); a forged one is rejected.
```

To run the **full** shielded flow (shield → private transfer → unshield) with real
testnet USDC you need a funded key and the proving artifacts:

```bash
bash scripts/setup-testnet-env.sh    # generate + friendbot-fund keys, write .env
bash scripts/fetch-artifacts.sh      # the exact zkeys/wasm that match the deployed VKs (sha256-pinned)
set -a; . ./.env; set +a
node tests/e2e/m1-flow.mjs            # shield → private transfer → unshield, prints Stellar Expert links
```

---

## The headline: batched on-chain verification

A naive privacy pool verifies **one proof per transaction** — every confidential
payout is its own pairing check and its own settlement. Benzo collapses the
verification of **N proofs sharing one verification key into a single BN254
pairing check**, using an in-contract Fiat-Shamir random-linear-combination:

```
∏ᵢ e(−rᵢ·Aᵢ, Bᵢ) · e((Σrᵢ)·α, β) · e(Σrᵢ·vk_xᵢ, γ) · e(Σrᵢ·Cᵢ, δ) = 1
```

The per-VK `α/γ/δ` terms **collapse** across the batch; the `rᵢ` are derived inside
the contract (`keccak256` transcript over the VK and every proof point), so a
prover can't choose them to cancel a bad proof. The matching Merkle side uses a
**subtree-merge** insert (`insert_leaves`) that commits N leaves in ~`N + depth`
Poseidon2 hashes instead of `N × depth`. Both are adversarially tested
(tampered / swapped / foreign-VK proofs all rejected; batch root proven identical
to sequential inserts).

| | Naive (one proof per tx) | Benzo `verify_batch` |
|---|---|---|
| BN254 `pairing_check` calls for N proofs | **N** | **1** (one multi-pairing, N+3 terms) |
| Merkle hashes for N leaves | N × depth | **~N + depth** (subtree merge) |
| Settlement transactions | N | **⌈N / cap⌉** (auto-chunked) |
| Trusted setup | per-circuit | unchanged (reuses the circuit's VK — no new ceremony) |

**Measured on live testnet (protocol 27):** `verify_batch` alone fits **~16**
same-VK proofs per tx and `insert_leaves` ~200 leaves; the *integrated*
`batch_transfer_org` (verify **+** 2N nullifier writes **+** 2N viewing-key binds
**+** 2N Merkle inserts) is settlement-bound at **~3 org spends per tx**, so the SDK
caps at 3 and auto-chunks larger runs. This is **batched verification, not
recursion** — the win is one pairing + one tx per chunk, a real but bounded factor.
Big-N aggregation (one wrapped proof for thousands) is off-chain recursion, future
work. See [`contracts/verifier_groth16/src/lib.rs`](contracts/verifier_groth16/src/lib.rs).

---

## What each of the 16 on-chain verification keys proves

Every key below is **registered and live** on the verifier and checked with the
BN254 host functions. The four **settle-gate** keys block a value move unless the
proof verifies; the rest are attestations and admission gates.

| VK | Circuit | What the proof establishes | Role |
|----|---------|----------------------------|------|
| `SHIELD` | `shield` | A USDC deposit becomes a valid note commitment | settle-gate |
| `TRANSFER` | `joinsplit` | 2-in/2-out private transfer; amount + counterparty hidden | settle-gate |
| `UNSHIELD` | `unshield` | A note is burned for a USDC withdrawal | settle-gate |
| `JSPLITORG` | `joinsplit_org` | Org transfer carrying **in-circuit M-of-N** member signatures; unlinkable org nullifier | settle-gate |
| `KYC` | `kyc_credential` | Holder has an issuer-signed KYC credential ≥ tier (admission) | admission gate |
| `SUM` | `proof_of_sum` | Owned notes sum to an exact disclosed total (no line items) | attestation |
| `BALANCE` | `proof_of_balance` | A note-backed balance statement | attestation |
| `FUNDS` | `funds_attestation` | Balance ≥ X (oracle-backed — see Honest limits) | attestation |
| `ORGAUTH` | `org_spend_auth` | Standalone M-of-N spend authorization | attestation |
| `ORGSUM` | `proof_of_sum_org` | M-of-N treasury total to an auditor (no salary revealed) | attestation |
| `ORGBAL` | `proof_of_balance_org` | Org "payroll funded ✓" / reserves / solvency threshold | attestation |
| `SPENDCAP` | `spending_cap` | A payout is within an approved cap, amount hidden | attestation |
| `POIPAYOUT` | `payout_innocence` | A payout's recipient is **not** on a deny/sanctions set, recipient hidden | attestation |
| `PAYCOMP` | `payroll_computation` | A run total was *computed* from a private rate card, not asserted | attestation |
| `KYB` | `kyb_credential` | Org holds a KYB credential; private, nullifier for Sybil resistance | attestation |
| `NETTING` | `cross_netting` | The net difference between two parties, balances hidden | attestation |

> Provenance for the seven business-ZK keys (re-registered 2026-06-23) is recorded
> with their on-chain tx hashes in
> [`deployments/testnet.json`](deployments/testnet.json) → `provenance.vkRegistrations`.

---

## Architecture

Three planes: a **client plane** that holds keys and proves (the headless
`@benzo/core`, or an attested TEE prover), an **on-chain plane** of Soroban
contracts that verify proofs and mutate state, and an **off-chain services plane**
that indexes encrypted notes, sponsors fees, and bridges fiat.

```
                    ┌──────────────── on-chain (Soroban, testnet) ─────────────────┐
  @benzo/core       │   pool ── verify ──► verifier_groth16  (BN254 / CAP-0074)     │
  (headless prover) │    │                   ▲  16 VKs · verify_proof · verify_batch│
   or PhalaProver ─►│    ├─ insert ─► merkle           (Poseidon2 tree, CAP-0075)  │
   (attested TEE)   │    ├─ spend  ─► nullifier_set     (persistent, idempotent)    │
   shield/transfer/ │    ├─ admit  ─► asp_membership ──► KYC-proof gate + freshness  │
   unshield + proof │    │                └─► issuer_registry · identity_nullifier   │
                    │    ├─ screen ─► asp_non_membership (deny-SMT, proof-of-innocence)│
                    │    └─ bind   ─► viewkey_anchor / mvk_registry (MVK→TVK disclosure)│
                    └──────────────────────────────────────────────────────────────┘
        ▲                       │ events (commitments, ciphertexts, nullifiers)
        │ gasless submit        ▼
  @benzo/relayer          @benzo/indexer ── viewing-key scan ──► holders & auditors
```

**Canonical invariants** (normative, asserted in tests):
`commitment = Poseidon2(amount, recipient_pk, blinding, asset_id)` ·
`nullifier = Poseidon2(spend_sk, leaf_index, DOMAIN)` ·
Merkle `DEPTH = 32`, `ROOT_HISTORY = 128` · Groth16/BN254, one constant-size
multi-pairing check · Poseidon2 **byte-identical** across the circom circuit, the
`@benzo/core` TS mirror, and the Soroban host function.

---

## What's real vs. simulated (read this first)

Benzo is an **honest work-in-progress**; this table is the source of truth.

### CORE — ZK that gates real value/admission, verified on-chain (testnet)

| Component | Status |
|---|---|
| Groth16 proving + BN254 verification | **Real** — snarkjs proofs verified on-chain via CAP-0074 host functions |
| Poseidon2 commitments / nullifiers / Merkle | **Real** — CAP-0075 host function, byte-identical to circuit & SDK |
| Shield / private transfer / unshield | **Real** — on testnet, real Circle USDC, on-chain nullifiers + commitments |
| Batched verification (`verify_batch` / `batch_transfer_org`) | **Real** — one pairing for N same-VK proofs; live, ~3 org spends/tx |
| Tiered-KYC admission (`asp_membership.admit_by_proof`) | **Real** — verifies the KYC credential proof on-chain, enforces tier + issuer + **credential freshness + sybil nullifier** |
| ASP allow-membership / proof-of-innocence | **Real** — enforced in-circuit against live on-chain registry roots |
| Org M-of-N dual-control (`pool.transfer_org`, `JSPLITORG`) | **Real** — settles only a spend carrying a valid in-circuit M-of-N proof; rejects a single-key consumer proof |
| MVK→TVK viewing-key disclosure | **Real** — HKDF + X25519/AES-GCM, reconstructed from on-chain ciphertext |
| Auditor disclose-total (`ORGSUM` / `proveTotal`) | **Real on-chain ZK** — proves the disclosed notes sum to a total (see set-completeness limit below) |

### TOOLING — real, supports the core

`@benzo/core` SDK + `@benzo/cli` · gasless relayer (non-custodial) · note-discovery
indexer · self-hosted SEP-1/10/24 anchor (real Ed25519, real USDC at both edges) ·
confidential TEE prover (Phala dstack / Intel TDX; client verifies the live
attestation quote, witness sealed to the attested key — adds confidentiality, soundness
still rests on the on-chain proof).

### FUTURE / REFERENCE — not load-bearing on-chain here

KYC providers / on-ramp / CCTP / accounting connectors → **mock / sandbox**, env-keyed
behind stable interfaces · the **fiat bank/cash leg is simulated** (the anchor credits
"fiat received/paid" with no real bank — the only simulated *protocol* piece) ·
Noir → UltraHonk "Track B" is reference-only, not deployed.

---

## Governance & honest limits

A confident submission states what it does *not* yet guarantee.

- **VK governance is a single admin key today.** It can `set_vk`/`rotate_vk` and
  re-point the pool's verifier with no timelock — so the keys are **not** immutable;
  they are admin-controlled. The hardening is a Stellar **M-of-N multisig** on the
  admin account (see [`docs/MAINNET-RUNBOOK.md`](docs/MAINNET-RUNBOOK.md)); until that
  is set, trust assumes an honest operator.
- **Anonymity-set cold-start.** Counterparty privacy is a property of the shielded
  pool's anonymity set. On a freshly-deployed testnet that set is small, so graph
  privacy here is an *architectural* property that compounds with adoption, not a
  fully-realized one today.
- **`proof_of_sum` proves ownership, not set-completeness.** A disclose-total proves
  the disclosed notes sum to the stated total; it does **not** prove the set is
  complete (an omitted note is undetectable). Completeness is bounded only by the
  authorized-MVK registry. Surfaced in the auditor UI, not oversold as "audited".
- **`FUNDS` (proof-of-funds) is oracle-backed.** It proves *an oracle signed
  balance ≥ X*, not pure ZK ownership — soundness rests on the oracle. It is not
  wired into a value-moving entrypoint.
- **Org-policy pinning (`org_account.verify_org_proof`) is on-chain but not yet
  SDK-routed.** The contract gate that pins a proof's member-root/threshold to the
  registered org exists and is tested; routing the standalone SDK attestations
  through it needs an `org_account` redeploy (follow-up). The `JSPLITORG`
  settlement money-path is already sound and unaffected.

No mainnet keys are used anywhere. Testnet-only, unaudited.

---

## Repository layout

```
contracts/    16 Soroban contracts (verifier_groth16, pool, merkle, nullifier_set,
              asp_membership, asp_non_membership, org_account, viewkey_anchor, …)
circuits/     Circom circuits (Groth16/BN254) + Poseidon2 params + manifest
packages/     @benzo/core (headless SDK + prover), ui, kyc, anchor, relayer, indexer, …
apps/         wallet (consumer) · console (business) · wallet-api · console-api · landing
tests/        replay-verify (permissionless) + e2e (real-USDC on-chain flows)
deployments/  testnet.json — the live cluster + VK provenance (single source of truth)
```

A **pnpm + Turborepo** monorepo: one headless core, many surfaces. Build everything
with `pnpm -r build`; test with `pnpm -r test` (heavy proving tests self-skip without
artifacts — the opt-in `zk-proofs` CI job fetches them and runs proofs for real).

---

## Stack

Soroban (Rust, `no_std`) · BN254 (CAP-0074) + Poseidon2 (CAP-0075), protocol 27 ·
Circom + snarkjs (Groth16) · TypeScript / React / Vite · `@stellar/stellar-sdk`.
