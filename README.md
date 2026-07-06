<p align="center">
  <img src="assets/readme/benzo-readme-banner.png" alt="Benzo" />
</p>

<p align="center">
  <strong>Private USDC payments on Avalanche.</strong><br />
  Encrypted balances and transfer amounts on a public chain — with a
  rotatable auditor key so privacy still passes an audit.
</p>

## What Benzo Is

Benzo is a private payments product being built on **Avalanche** with
**eERC (Encrypted ERC)** — AvaCloud's privacy-preserving, ERC-20-style token
standard. Balances and transfer amounts are encrypted on-chain using
zk-SNARKs (Groth16) and ElGamal encryption over BabyJubJub. Proofs are
generated client-side, everything settles fully on-chain with no relayers,
and a rotatable auditor key lets a designated auditor decrypt when
compliance demands it.

This repo is the Benzo entry for the **Avalanche Team1 India Speedrun —
Privacy on Avalanche** (July 1–19, 2026).

> **Status: live on Avalanche Fuji.** The eERC private-token stack is deployed
> to Fuji C-Chain (chain id `43113`) and verified end-to-end — mint → shield →
> confidential transfer → withdraw, with on-chain Groth16 proof verification.
> Addresses are in [`contracts/deployments/fuji.json`](contracts/deployments/fuji.json)
> and listed under [Deployed on Fuji](#deployed-on-fuji) below.
>
> Benzo previously shipped a full shielded-USDC protocol on Stellar/Soroban
> (16 Soroban contracts, 16 Groth16 circuits, a wallet, and a business console
> on Stellar testnet); that implementation was retired when the project pivoted
> chains and is preserved in git history at tag/commit `fbb4d4e`.

## The Two Privacy Primitives

**eERC — data privacy on an open chain.** Two deployment modes:

- **Standalone** — a brand-new private token with private mint/burn and an
  optionally hidden total supply.
- **Converter** — wrap an existing ERC-20 (e.g. a stablecoin) and flip
  between public and private via deposit/withdraw. This is the
  shielded-stablecoin mode Benzo's flows are built around.

**Permissioned L1 — access privacy for the whole chain (live on Fuji).**
**BenzoNet**, a sovereign Avalanche L1 (chain id `68420`, gas token `BGAS`), is
**deployed and validating on Fuji**. Subnet-EVM allowlist precompiles
(tx allowlist at `0x02…02`, deployer allowlist at `0x02…00`, native minter at
`0x02…01`, fee manager at `0x02…03`) gate who can transact and deploy, and a
`validatorOnly` node config restricts who can even read. eERC runs on custom
L1s, so the two primitives stack: encrypted amounts on a gated chain. Full
deploy record — subnet/blockchain IDs, validator, PoA validator manager — is in
[`infra/benzonet-fuji.json`](infra/benzonet-fuji.json).

## Stack

| Layer | Choice |
|---|---|
| Chain | Avalanche **Fuji** testnet — chain id `43113`, RPC `https://api.avax-test.network/ext/bc/C/rpc` |
| Contracts | [`ava-labs/EncryptedERC`](https://github.com/ava-labs/EncryptedERC) v0.0.4 — Solidity 0.8.27, OpenZeppelin 5.x |
| Circuits | eERC's audited Circom circuits (registration / mint / transfer / withdraw / burn), Groth16, compiled with `@solarity/hardhat-zkit` (circom 2.1.9) |
| Tooling | Node ≥ 22, pnpm workspaces, Hardhat ^2.22, Biome |
| Frontend SDK | [`@avalabs/eerc-sdk`](https://www.npmjs.com/package/@avalabs/eerc-sdk) 1.x — React hooks over wagmi v2 + viem v2; proofs generated in-browser via snarkjs (`circuitURLs` point at the compiled `.wasm`/`.zkey`) |
| Explorer | [testnet.snowtrace.io](https://testnet.snowtrace.io) — contract verification via Routescan (`https://api.routescan.io/v2/network/testnet/evm/43113/etherscan`, no API key) |

Key protocol facts that shape the code:

- **Deploy order matters:** Groth16 verifiers → `Registrar` → `EncryptedERC`
  → `setAuditorPublicKey`. Private operations revert until an auditor key is
  set.
- **Registration is per-address per-chain**, and the user's decryption key is
  derived from a deterministic wallet signature — wallets with
  non-reproducible signing (some MPC setups) can't participate.
- **The frontend serves circuit artifacts:** after `hardhat zkit make`, each
  circuit's `.wasm` + `.zkey` must be copied into the app's `public/` and
  wired into the SDK's `circuitURLs`.

## Deployed on Fuji

The eERC converter stack is live on **Avalanche Fuji C-Chain** (chain id `43113`).
Full record — every address, deploy tx hash, and Snowtrace link — is in
[`contracts/deployments/fuji.json`](contracts/deployments/fuji.json).

| Contract | Address |
|---|---|
| EncryptedERC (converter) | [`0x46688f1704a69a6c276cCCB823E36C80787B0FA2`](https://testnet.snowtrace.io/address/0x46688f1704a69a6c276cCCB823E36C80787B0FA2) |
| Registrar | [`0x9a63FEa9851097DBAf3757b636217fdde50ABaF0`](https://testnet.snowtrace.io/address/0x9a63FEa9851097DBAf3757b636217fdde50ABaF0) |
| TestUSDC (tUSDC, demo faucet) | [`0x1226C73Bd8022080b8DbCDC24AA8B61D659A835f`](https://testnet.snowtrace.io/address/0x1226C73Bd8022080b8DbCDC24AA8B61D659A835f) |

Plus five Groth16 verifiers (registration / mint / transfer / withdraw / burn).
The auditor public key is set and its account registered. **All nine contracts
have verified source on Snowtrace** (click any address above → the Contract tab).

**Wrapped token.** The converter wraps any ERC-20 by address, so it supports two:

- **Circle USDC** — official testnet USD Coin (`0x5425890298aed601595a70AB815c96711a31Bc65`,
  6 decimals) is the real asset Benzo shields. Get it from the
  [Circle testnet faucet](https://faucet.circle.com) (Avalanche Fuji).
- **tUSDC** — our own 6-decimal token with an unlimited public faucet, for
  frictionless demos (Circle's faucet is rate-limited to 20 USDC / 2h).

## Repository Layout

```text
contracts/    Hardhat workspace — eERC stack deployed to Fuji (deployments/fuji.json)
apps/         Frontend app(s) — wagmi v2 + viem v2 + @avalabs/eerc-sdk (planned)
services/     Hosted API — Fastify + Postgres (onboarding, identity, jobs)
assets/       Brand assets
```

## Run Locally

Prerequisites: Node.js 22+, pnpm.

```bash
pnpm install
cp .env.example .env       # fill in PRIVATE_KEY (Fuji test key — never a funded mainnet key)
pnpm compile               # compile the contracts workspace
```

Get test AVAX from the [Fuji faucet](https://core.app/tools/testnet-faucet/?subnet=c&token=c)
(coupon `avalanche-academy` works) or the Builder Hub login faucet.

## License

The Benzo codebase is Apache-2.0. Note that `ava-labs/EncryptedERC` is
licensed under the **Ava Labs Ecosystem License v1.1** — its use is limited
to the Avalanche platform (mainnet/Fuji/L1s) and non-commercial
testing/research within the Avalanche ecosystem. This project deploys to
Fuji only.
