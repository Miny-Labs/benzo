# Benzo — Autonomous Build (read this first)

This is an **unattended, end-to-end build**. You have everything you need locally — do not wait for human input.

## Source of truth
- **`AGENT_SPEC.md`** — operational spec: env, OrbStack, wallets, infra, build order, full resource list. READ FIRST.
- **`BENZO.md`** — full design. The *Canonical Invariants* box and *Section 10* (repo + M0–M5 roadmap) are authoritative.
- **`reference/`** — downloaded skills + starter code + offline docs (work offline). Fork `reference/code/stellar-private-payments` as the primary starter; `reference/code/soroban-examples` has `groth16_verifier`.

## Scope
Backend / protocol only. **No frontend/UI.** Contracts stay auth-agnostic (Ed25519 CLI key, no passkeys). Proving is
**headless** (Node/CLI, not a browser). **Self-host Mercury + Anchor. No MoneyGram. Testnet only.**

## Environment
Load once per shell: `set -a; . ./.env; set +a` → funded testnet keys, network, USDC issuer. Stellar identities are
already saved: `benzo-deployer`, `benzo-relayer`, `benzo-anchor-dist`, `benzo-anchor-sign`. Deploy with
`--source benzo-deployer --network testnet`. If USDC balance is 0 at M1, fall back to a self-issued SAC test token
(`USE_TEST_TOKEN=true`) minted from the deployer — never block on funding.

## Canonical commands (create/keep these as you scaffold)
- Build contracts: `stellar contract build` (or `cargo build --target wasm32-unknown-unknown --release`)
- Test contracts: `cargo test`
- Circuits: `circom` + `snarkjs` (Groth16) / `nargo` + `bb` (Noir UltraHonk) — install if missing
- Deploy: `stellar contract deploy --source benzo-deployer --network testnet ...`
- Prove: headless in Node (snarkjs / bb.js) — **never a browser**
- On-chain verify / flows: `stellar contract invoke ...` — always print the tx hash + result + a
  `https://stellar.expert/explorer/testnet/tx/<hash>` link into the conversation

## Hard rules
- Never commit `.env` or use a mainnet key (`.env` and `reference/` are gitignored — keep it that way).
- Poseidon2 parameterization **byte-identical** between circuit and host function (pin once, assert in a test).
- Nullifiers in **persistent** storage only.
- **Print every deploy/test/tx result and explorer link into the conversation** — progress must be verifiable from
  the transcript (the goal evaluator only sees what you surface here).
- Write tests as you go (circuit negative tests, contract unit/fuzz, e2e). If you mock anything (e.g. the fiat leg),
  say so in the README. Maintain a todo list. Work **M0→M5 in order**, de-risking M0 (one real proof verified
  on-chain) before anything else.
