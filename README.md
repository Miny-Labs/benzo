# Benzo — private-by-default shielded-USDC payments on Stellar

**Benzo** is a private-by-default, shielded-USDC payments protocol on Stellar
(Soroban), delivered as a private cross-border remittance corridor. Everyday
stablecoin payments hide **both amount and counterparty** through zero-knowledge
shielded notes, while compliance — selective disclosure via hierarchical viewing
keys and Association-Set screening — is built into the regulated fiat edges.

This repository is the **backend / protocol** (no frontend): ZK circuits, a
headless proving SDK, the Soroban contracts, a self-hosted note-discovery
indexer, a gasless relayer, and a self-hosted SEP-24 anchor corridor — all
exercised against **Stellar testnet** with real Circle testnet USDC.

> Built for **Stellar Hacks: Real-World ZK**. ZK is load-bearing by
> construction: strip the proofs and there is no private payment — the pool
> verifies a Groth16 proof on Stellar's native BN254 host functions before it
> will move a cent.

---

## What's real vs. simulated (read this first)

| Component | Status |
|---|---|
| Groth16 proving (shield / joinsplit / unshield) | **Real** — headless snarkjs in Node, verified on-chain by the BN254 verifier contract |
| BN254 Groth16 verification | **Real** — Soroban CAP-0074 host functions, on testnet |
| Poseidon2 commitments / nullifiers / Merkle | **Real** — CAP-0075 host function, byte-identical to circuit & SDK (asserted in tests) |
| USDC custody & settlement | **Real** — Circle testnet USDC (issuer `GBBD47IF…FLA5`) as a SAC, custodied by the pool |
| Shield / private transfer / unshield | **Real** — on testnet, with on-chain nullifiers, Merkle commitments, balance moves |
| MVK→TVK viewing-key disclosure | **Real** — HKDF derivation, X25519+AES-GCM, reconstructed from on-chain ciphertext |
| ASP membership / proof-of-innocence | **Real** — enforced in-circuit + on-chain registries |
| Gasless relayer | **Real** — submits proven transfers, paid in USDC out of the pool |
| Note-discovery indexer | **Real** — scans Soroban events, viewing-key scan API (self-hosted, no Mercury key) |
| SEP-1 / SEP-10 / SEP-24 anchor | **Real wire protocol** — self-hosted; real on-chain USDC settlement at both edges |
| **The fiat (bank/cash) ledger leg** | **SIMULATED** — our self-hosted anchor credits "fiat received" / "fiat paid out" with no real bank. This is the only simulated piece, and it is driven explicitly via `POST /sep24/sim/:id`. |

No mainnet keys are used anywhere. `.env` and `reference/` are gitignored.

---

## Architecture

Three planes (BENZO.md §4): a **client plane** that holds keys and proves
(here: the headless `@benzo/sdk`), an **on-chain plane** of Soroban contracts
that verify proofs and mutate state, and an **off-chain services plane** that
indexes encrypted notes, sponsors fees, and bridges fiat.

```
                       ┌──────────────────────── on-chain (Soroban, testnet) ───────────────────────┐
  @benzo/sdk           │   pool ──verify──► verifier_groth16  (BN254 / CAP-0074)                     │
  (headless prover) ──►│    │                                                                        │
   shield/transfer/    │    ├─ insert ─► merkle           (Poseidon2 incremental tree, CAP-0075)     │
   unshield + proof    │    ├─ spend  ─► nullifier_set     (persistent, idempotent)                  │
                       │    ├─ check  ─► asp_membership    (allow-set, deposit edge)                 │
                       │    ├─ check  ─► asp_non_membership (deny-SMT, proof-of-innocence)           │
                       │    └─ bind   ─► viewkey_anchor    (MVK→TVK disclosure registry)             │
                       └────────────────────────────────────────────────────────────────────────────┘
        ▲                         │ events (commitments, ciphertexts, nullifiers)
        │ gasless submit          ▼
  @benzo/relayer            @benzo/indexer ──viewing-key scan──► holders & auditors
        ▲
        │ fiat edges (SEP-10 JWT + SEP-24 deposit/withdraw; USDC settled on-chain, fiat SIMULATED)
  @benzo/anchor
```

### Canonical cryptographic invariants (normative)

- **Commitment** `= Poseidon2(amount, recipient_pk, blinding, asset_id)`
- **Nullifier** `= Poseidon2(spend_sk, leaf_index, NULLIFIER_DOMAIN)`
- **Merkle node** `= Poseidon2(left, right)`; tree `DEPTH = 32`, `ROOT_HISTORY = 128`
- **Proof** Groth16 over BN254, one constant-size multi-pairing check
- **Poseidon2 byte-identical** across circom circuit, the `@benzo/sdk` TS mirror,
  and the Soroban host function — pinned in
  [`circuits/poseidon_params/poseidon2_bn254.json`](circuits/poseidon_params/poseidon2_bn254.json)
  and asserted against the on-chain zero table in tests.
- **Nullifiers in persistent storage only**; idempotent "already spent = success".

---

## Repository layout

```
contracts/                 Soroban (Rust) workspace
  pool/                    SAC USDC custody; shield / transfer / withdraw orchestration
  verifier_groth16/        BN254 Groth16 verifier, multi-VK registry (CAP-0074)
  merkle/                  incremental Poseidon2 tree, 128-root history (CAP-0075)
  nullifier_set/           persistent, idempotent double-spend prevention
  asp_membership/          allow-set Merkle tree (deposit edge)        [forked: Nethermind PoC]
  asp_non_membership/      deny sparse-Merkle tree (proof-of-innocence)[forked: Nethermind PoC]
  viewkey_anchor/          MVK→TVK disclosure registry
  common/                  shared types + Poseidon2 host wrappers       [forked: Nethermind PoC]
circuits/
  groth16/                 shield.circom, joinsplit.circom, unshield.circom (+ note/lib)
  poseidon_params/         pinned Poseidon2 params (source of truth) + zkhash reference
  ptau/                    Hermez Powers-of-Tau (Phase-1)
sdk/                       @benzo/sdk — Poseidon2, notes, merkle mirror, prover, viewkeys, clients
indexer/                   @benzo/indexer — event scan + viewing-key scan API
relayer/                   @benzo/relayer — gasless transfer submission
anchor/                    @benzo/anchor — self-hosted SEP-1/10/24 (real edges, simulated fiat)
scripts/                   deploy + codegen + param extraction
tests/                     e2e flows (M1) + compliance (M2) + corridor (M3) + green vitest
docs/                      threat model
```

---

## How to run

### Prerequisites
- Stellar CLI 25+, Rust + `wasm32v1-none`, Node 20 + pnpm, `circom` 2.2+, `snarkjs`.
- `set -a; . ./.env; set +a` — funded testnet identities `benzo-deployer`,
  `benzo-relayer`, `benzo-anchor-dist`, `benzo-anchor-sign` (already saved).

### Build & test the contracts
```bash
cargo test --workspace          # 85 tests across the 8 contracts + zkhash
stellar contract build          # all 7 contracts -> wasm32v1-none
```

### Build circuits & keys (Groth16)
```bash
# one-time: compile circuits, run a Phase-2 contribution, export VKs
for c in shield joinsplit unshield; do
  circom circuits/groth16/$c.circom --r1cs --wasm -o circuits/build/$c -l circuits/lib
  snarkjs groth16 setup circuits/build/$c/$c.r1cs circuits/ptau/powersOfTau28_hez_final_16.ptau circuits/build/$c/${c}_0.zkey
  echo entropy | snarkjs zkey contribute circuits/build/$c/${c}_0.zkey circuits/build/$c/$c.zkey
  snarkjs zkey export verificationkey circuits/build/$c/$c.zkey circuits/build/$c/${c}_vk.json
done
```

### Build the TypeScript packages
```bash
pnpm install
pnpm -r build                   # @benzo/sdk, indexer, anchor, relayer
( cd sdk && pnpm test )         # 18 tests incl. circuit proving + Poseidon2 byte-identity
```

### Deploy to testnet
```bash
set -a; . ./.env; set +a
bash scripts/deploy-testnet.sh  # deploys all contracts, wires operators, registers VKs
# one-time: open a USDC trustline for the relayer so it can take USDC fees
#   (see scripts/deploy-testnet.sh notes)
```

### Run the flows against testnet
```bash
set -a; . ./.env; set +a
export ANCHOR_JWT_SECRET=...     # any secret for the self-hosted anchor JWTs
cd tests
node e2e/m1-flow.mjs             # shield → private transfer → unshield (different account)
node e2e/m2-compliance.mjs       # MVK/TVK disclosure + ASP both gates
node e2e/m3-corridor.mjs         # SEP-24 corridor: fiat-sim → … → fiat-sim
pnpm exec vitest run e2e/e2e.test.mjs   # green suite driving items 1–5
```

---

## Compliance model ("open by default, private when needed, compliant")

- **Privacy in the middle.** `transfer` is a 2-in/2-out join-split; amounts and
  the sender↔recipient link are hidden. No SAC movement.
- **Identity at the edges.** `shield` requires an **ASP allow-membership** proof
  (the depositor is bound in-circuit to a KYC'd allow-set leaf). `withdraw`
  requires an **ASP non-membership / proof-of-innocence** proof against the
  deny sparse-Merkle tree.
- **Guaranteed auditability.** Every note carries an MVK tag
  `Poseidon2(mvk_pub, blinding)`; a scoped **TVK** (one-way HKDF from the MVK)
  lets an auditor passively reconstruct exactly the in-scope notes from on-chain
  ciphertext — and nothing else. Viewing keys are decrypt-only; they never carry
  spend authority.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

---

## Credits

Forks the Nethermind **stellar-private-payments** PoC (ASP contracts, Poseidon2
host wrappers, Groth16 verifier shape — Apache-2.0) and the canonical
`soroban-examples/groth16_verifier`. Circuits build on tornado-nova's join-split
shape, re-expressed over Poseidon2 with Benzo's note model and compliance gates.

**Status:** testnet, unaudited. Not for production / real funds.
