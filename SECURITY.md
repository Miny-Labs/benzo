# Benzo — Security & Threat Model

Benzo is a shielded-USDC payments protocol on Stellar/Soroban: private by
default, compliant by construction (ASP screening at the edges + selective
disclosure via viewing keys). This document is the auditor-facing summary of the
trust model, security properties, known attack surface, and the current
audit-readiness status. It is deliberately blunt about what is *not* yet done.

> Status: **testnet, not externally audited.** Trusted setup is currently a
> single-machine simulation (see [Trusted setup](#trusted-setup--ceremony)). Do
> not use with mainnet funds until the two external blockers (audit + multi-party
> ceremony) are closed.

## Threat model — actors & trust assumptions

| Actor | Trusted for | NOT trusted for | Mitigation |
|---|---|---|---|
| **Prover (user)** | nothing | — | every spend is proven in-circuit (value conservation, nullifier, Merkle membership) |
| **Relayer** | liveness only | cannot alter amounts/recipients/fee | the proof binds `ext_data_hash` (relayer, fee, recipient, ciphertexts) in-circuit |
| **ASP allow-set operator** | curating *who may deposit* | cannot forge membership | allow-root is a public circuit input checked against the live on-chain root |
| **ASP deny-set operator** | curating *who is flagged* (can freeze a flagged commitment) | cannot make an honest note un-spendable | admin-gated + event-observable; **must be a multisig/timelock**; honest notes default-exclude (always-exit) |
| **Viewing-key (TVK) holder / auditor** | reading *in-scope* notes only | cannot spend; cannot read out-of-scope notes | TVK is one-way-derived per scope; grants are scoped + expiring + revocable |
| **Pool admin** | verifier/cap/pause governance | cannot move custodied funds | admin-gated, event-emitting; **must be a multisig/timelock** (currently a single key — gap B9) |
| **Sponsor / relayer service** | paying XLM fees + reserves | never custody; never sees the user's secret | non-custodial onboarding (server co-signs only); relayer can submit only a proven `transfer` |

**In-circuit (trustless):** MVK tag, ASP allow-membership at deposit, ASP
non-membership (proof-of-innocence) at withdraw — all proven against live
on-chain roots. **Off-circuit (trusted):** MVK-ciphertext payload integrity and
ASP set *curation* are operator responsibilities, not circuit-enforced.

## Security properties & invariants

- **Value conservation (no mint):** `Σ inputs = Σ outputs + fee` enforced
  in-circuit (`joinsplit`/`unshield`); every amount is 64-bit range-checked
  *before* summation (negative-tested for field wraparound).
- **Turnstile backstop:** the pool tracks net shielded supply (`Σ deposits −
  Σ withdrawals`); a withdrawal can never exceed it. This bounds the blast radius
  of *any* undiscovered circuit-soundness bug to funds actually deposited — a
  forged proof can never mint value. (`pool.total_shielded`; negative-tested.)
- **No double-spend:** per-entry persistent nullifiers; replays are idempotent
  no-ops, never a second debit.
- **No duplicate leaves:** the Merkle contract rejects a replayed commitment,
  preserving scanner leaf→index injectivity.
- **Merkle soundness + root window:** membership folds to a public root; the pool
  accepts a bounded ring buffer (128) of recent roots via an O(1) presence index.
- **Anti-malleability:** transfer/withdraw bind a relayer/fee/recipient
  `ext_data_hash` in-circuit, so a relayer cannot alter a proven transaction.
- **Soundness fails closed:** a non-verifying proof returns `Err(InvalidProof)`;
  the verifier validates VK structure at registration and rejects
  tampered/cross-circuit/wrong-input proofs (negative-tested with real proofs).
- **Honest users always exit:** the deny-SMT default-excludes everyone, so
  proof-of-innocence succeeds for any honest note — privately, no special op.
- **Selective disclosure is bounded:** a leaked/offboarded TVK exposes only its
  own in-scope notes (vs a single master-viewing-key escrow).
- **State durability (CAP-0078):** long-lived persistent entries (VK, pool
  config, live roots, nullifiers, net supply) proactively extend TTL on the hot
  path.
- **Key separation:** spend / master-viewing / note-discovery authorities are
  distinct; viewing keys never carry spend authority.

## Known attack surface (the classes an audit must scrutinize)

- **Under-constrained circuit signals** — the #1 ZK bug class. Mitigation status:
  constraints read correct + negative-tested, but **circuit static analysis
  (Circomspect/Picus) has not yet been run** (gap B3) — this is exactly what
  found the closest audited peer's (0xbow Privacy Pools) criticals.
- **Hash desync** (circom ↔ TS ↔ Soroban Poseidon2 constants) — a real
  fund-loss class. Mitigation: cross-implementation parity tests; a CI
  regeneration-diff guard is being added (gap B2).
- **Nullifier uniqueness / fee > amount / ASP-root-update DoS** — covered by
  in-circuit constraints + on-chain checks; flagged for explicit audit attention.
- **Soroban specifics** — `require_auth` coverage (negative-tested),
  `overflow-checks = true` + `checked_*`, persistent-only nullifiers,
  reentrancy/cross-contract trust (verifier, ASP).

## Trusted setup / ceremony

**Current (testnet):** `scripts/ceremony.sh` runs a Groth16 Phase-2
multi-*contribution* sequence + beacon, but on a single machine with locally
generated contributors and `/dev/urandom` entropy — a **simulation, not a real
ceremony**, and only the `joinsplit` transcript currently exists.

**Required before mainnet (gap E1):** a real Phase-2 for **all** circuits
(`shield`, `joinsplit`, `unshield`, `proof_of_balance`) with **≥2 independent
external contributors on separate hardware**, each publishing identity +
contribution hash + machine attestation, finalized with a **public verifiable
beacon** (e.g. drand / a future Ethereum block hash). The transparent-setup
Track B (Noir→UltraHonk) needs no ceremony and is the strategic hedge.

## Audit status & readiness

**Not externally audited.** In-repo hardening completed toward audit-readiness:
turnstile backstop, negative/adversarial tests with real proofs, cross-impl hash
parity tests, `unwrap_used`/`unsafe_code` lint gates, pinned toolchain,
cargo-deny. Remaining buildable items are tracked as B1–B10; the two external
blockers are **E1 (real ceremony)** and **E2 (third-party audit of circuits +
contracts)** — brief the firm explicitly against the attack-surface classes
above. The audited reference peers to benchmark coverage against are **0xbow
Privacy Pools** (Auditware + Oxorio), **Railgun** (ABDK + Trail of Bits + Zokyo),
and **Nocturne** (Zellic).

## Responsible disclosure

Report security issues privately to the maintainer (see repo contact) rather than
via public issues. Testnet only; there are no mainnet funds at risk today.
