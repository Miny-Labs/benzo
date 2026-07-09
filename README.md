<p align="center">
  <img src="assets/readme/benzo-readme-banner.png" alt="Benzo" />
</p>

<p align="center">
  <a href="https://github.com/Miny-Labs/benzo/actions/workflows/ci.yml">
    <img src="https://github.com/Miny-Labs/benzo/actions/workflows/ci.yml/badge.svg" alt="ci" />
  </a>
</p>

<p align="center">
  <strong>Private USDC-style payments on Avalanche.</strong><br />
  Shield a public ERC-20 into an encrypted eERC balance, send it privately,
  and keep a rotatable auditor key for controlled review.
</p>

## Provenance & Delta

Benzo v1 shipped on Stellar/Soroban: 16 Soroban contracts, 16 Groth16
circuits, a wallet, and a business console. That version is preserved at the
[`stellar-final`](https://github.com/Miny-Labs/benzo/tree/stellar-final) tag,
which points to commit
[`fbb4d4e`](https://github.com/Miny-Labs/benzo/commit/fbb4d4e).

This Avalanche version is a ground-up rebuild. The contracts stack is new and
is based on [`ava-labs/EncryptedERC`](https://github.com/ava-labs/EncryptedERC)
v0.0.4, Groth16/Circom proofs, and ElGamal encryption over BabyJubJub. The
apps, service layer, deployment scripts, and permissioned L1 infrastructure are
new for Avalanche.

Zero code is shared with the Stellar implementation. Only the Benzo name and
the product thesis carry over.

## What Benzo Does

Benzo is a private payments system for stablecoin workflows. Users register an
eERC key, deposit a public ERC-20 into the converter, and then send encrypted
balances on-chain. Groth16 proofs enforce balance correctness while transfer
amounts and balances stay encrypted. A designated auditor public key receives a
separate decryptable ciphertext for compliance review.

Privacy in this README means privacy enforced by on-chain proofs and
encryption. Benzo does not claim to hide addresses, timestamps, gas payments,
or product workflow metadata unless a section says so explicitly.

## Architecture

```mermaid
flowchart LR
  A["Wallet / Console<br/>eerc-sdk · in-browser proofs"] -->|Groth16 proof| B["EncryptedERC converter<br/>Registrar · 5 verifiers"]
  A -->|SIWE session| C["services/api<br/>orgs · payroll · activity"]
  B -. auditor ciphertext .-> D["Rotatable auditor key"]
  B --> E["Avalanche<br/>C-Chain mainnet · Fuji · BenzoNet L1"]
```

The wallet and console use `@avalabs/eerc-sdk` with wagmi/viem, snarkjs, and
served circuit files (`.wasm` and `.zkey`) to produce proofs in the browser.
Those proofs settle against the `Registrar`, `EncryptedERC`, and five Groth16
verifier contracts. Every private operation also carries an auditor ciphertext
encrypted to the current auditor public key. The `services/api` layer holds
session, org, and workflow state; it never sees decrypted balances.

BenzoNet is the permissioned deployment path: an Evergreen-style institutional
L1 with PoA validator control, `txAllowList` as the KYC gate, a valueless gas
token (`BGAS`), and `validatorOnly` read privacy. Benzo deliberately stops
there; no extra institutional machinery is added just to chase the label.

## The Six Flows

### 1. Private Payroll

A company funds a treasury, registers employees, and sends payroll through
eERC private transfers. The proof system protects payroll amounts on-chain;
the payroll schedule, roster, and approval state are workflow data that belong
in the console/API layer.

```mermaid
flowchart LR
  C["Console / API<br/>roster · schedule"] -. orchestrates .-> T["Company treasury"]
  T -->|eERC private transfer| E1["Employee"]
  T -->|eERC private transfer| E2["Employee"]
```

### 2. Shielded Stablecoin Transfers

A user deposits a public test ERC-20 such as `tUSDC`, receives an encrypted
balance, and sends privately to another registered user. The receiver decrypts
locally and can later withdraw back to a public ERC-20 balance.

```mermaid
flowchart LR
  P["Public tUSDC"] -->|deposit / wrap| B["Your encrypted balance"]
  B -->|private transfer| B2["Recipient balance"]
  B2 -->|withdraw| P2["Public tUSDC"]
```

### 3. Auditor-Ready Treasury

An organization can operate with encrypted treasury balances while still
keeping an auditor path. The on-chain contract is configured with a current
auditor public key; the demo key is operator-controlled in this repo, not an
independent custodian.

```mermaid
flowchart LR
  Tx["Private eERC transfer"] -->|ciphertext to owner| O["Owner reads balance"]
  Tx -->|ciphertext to auditor key| A["Auditor decrypts for review"]
```

### 4. KYC-Gated Chain (Stretch)

BenzoNet is the permissioned-chain path for institutions that need both eERC
amount privacy and chain access control. The current service includes mock KYC
workflow state; a real provider integration is outside this repo state.

```mermaid
flowchart LR
  U["User address"] --> G{"txAllowList gate<br/>precompile"}
  G -->|allowed| L["BenzoNet L1<br/>eERC + BGAS"]
  G -->|not allowed| X["rejected"]
```

### 5. Confidential B2B Settlement

Invoices can be represented by opaque commitments while the settlement itself
uses an eERC private transfer. The commitment registry is bookkeeping: it does
not prove that a specific transfer paid a specific invoice.

```mermaid
flowchart LR
  I["InvoiceRegistry<br/>opaque commitment"] -. bookkeeping .-> P["Payer"]
  P -->|eERC private transfer| Q["Payee"]
```

### 6. Private Gifting

Gift links have two tiers. The public escrow contract is simple and visible on
chain. The private bearer-link path uses an ephemeral registered address and an
eERC private transfer, so the amount is encrypted but the link is a bearer
secret.

```mermaid
flowchart LR
  S["Sender"] -->|public path| G["GiftEscrow<br/>amount visible"]
  S -->|private path| E["Ephemeral address<br/>+ eERC transfer"]
  E --> B["Bearer-link claim<br/>amount encrypted"]
```

## What Is Real vs. Simulated

| Area | Real today | Boundary to keep honest |
| --- | --- | --- |
| eERC stack | `EncryptedERC`, `Registrar`, five Groth16 verifiers, and `BabyJubJub` are deployed on **Avalanche C-Chain mainnet (`43114`)**, Fuji (`43113`), and the BenzoNet L1 (`68420`). | Mainnet is a **fresh deploy**: unaudited, and the `Ownable` admin is still the hot deploy key (not yet moved to a multisig / cold wallet). All ten mainnet contracts are source-verified on Snowtrace — see the mainnet table below. |
| BenzoNet L1 (the bonus combo) | The same eERC stack is deployed on the BenzoNet L1 (`68420`). A **real confidential eERC transfer runs on it** (deposit + private transfer, decrypt-verified) and the **tx-allowlist precompile gates every transaction** — a funded non-member is rejected on-chain. So encrypted amounts move *inside* a gated chain. Public RPC `rpc.benzo.space`, explorer [explorer.benzo.space](https://explorer.benzo.space). See [Live proof on BenzoNet](#deployed-on-benzonet-l1--the-bonus-combo-proven). | `validatorOnly` read-restriction is intentionally left OFF so the demo stays publicly verifiable; a production institutional deployment enables it. BenzoNet is a single-validator PoA chain. |
| Stablecoin asset | Mainnet wraps **real Circle USDC** (`tokenId 1`) and EURC (`tokenId 2`); Fuji wraps Circle **testnet** USDC + EURC; BenzoNet wraps a faucet `tUSDC`. | The mainnet converter holds real value — treat it as an unaudited, fresh deployment, not a hardened production system. |
| Privacy | Groth16 verifiers and BabyJubJub encryption enforce encrypted balances and transfer amounts on-chain. | Addresses, timing, token approvals, gas funding, and workflow labels are still public or off-chain metadata. |
| Proving setup | The five verifiers backing mainnet come from a **completed Groth16 phase-2 ceremony** (three sequential contributions on separate ephemeral machines, sealed with a public drand beacon); see [`docs/ceremony/transcript.md`](docs/ceremony/transcript.md). | It was a single-coordinator, 3-machine run — **not** an open multi-party ceremony with external participants; its soundness rests on the published, re-verifiable transcript plus the unbiasable beacon. Generated `.wasm`/`.zkey` artifacts stay uncommitted. |
| Auditor | An auditor public key is set on-chain on mainnet, Fuji, and BenzoNet, so private operations are enabled (they fail closed until it is set). | The auditor is an operator-controlled key, not an independent audit firm or custody system. |
| Wallet and console | The mobile-first wallet and desktop-first console are ported to the Avalanche/eERC stack and live in their own repos: [`Miny-Labs/benzo-wallet`](https://github.com/Miny-Labs/benzo-wallet) and [`Miny-Labs/benzo-console`](https://github.com/Miny-Labs/benzo-console). | This repository is backend + infrastructure only; it has no `apps/` workspace. |
| API service | `services/api` has Fastify, Postgres, SIWE sessions, onboarding, activity indexing, orgs, contacts, handles, and invite metadata. | KYC is mock-only. Workflow data is not payment privacy. |
| Payroll | Org treasury custody and roles are modeled in the API. | Server-side payroll proving and production custody controls are follow-up work. |
| B2B invoices | `InvoiceRegistry` stores commitment-only invoices and payee attestations. | It does not verify payment amount, token, or that an eERC transfer belongs to an invoice. |
| Gift links | `GiftEscrow` is tested for public-token gifts; the private bearer-link path is exercised by script. | Public escrow reveals amount/sender/timing. Private bearer links have no on-chain expiry or refund enforcement. |

## Deployed on Avalanche Mainnet — live

The full eERC converter stack plus the gift-escrow and CCTP peripherals are
**deployed on Avalanche C-Chain mainnet (`43114`)** and wrap **real Circle USDC**
(`tokenId 1`) and EURC (`tokenId 2`). The auditor public key is set on-chain.
Source of truth: [`contracts/deployments/avalanche.json`](contracts/deployments/avalanche.json)
and [`packages/config/src/deployments/avalanche.json`](packages/config/src/deployments/avalanche.json).
A per-network breakdown for all three chains lives in [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md).

This is a **fresh deployment**: it is unaudited and the `Ownable` admin is still
the hot deploy key (`0x09b6…9846`), not yet transferred to a multisig / cold
wallet. The "Verified" column reflects the deployment manifest — all ten mainnet
contracts are source-verified on Snowtrace.

| Contract | Address (C-Chain `43114`) | Verified |
| --- | --- | --- |
| `EncryptedERC` converter | [`0x708d0b83461973F46041a36f588b8760dbC0Db0e`](https://snowtrace.io/address/0x708d0b83461973F46041a36f588b8760dbC0Db0e) | yes |
| `Registrar` | [`0x902B8D5585A5124C9B9c001A95b7f520C07a79F2`](https://snowtrace.io/address/0x902B8D5585A5124C9B9c001A95b7f520C07a79F2) | yes |
| `BabyJubJub` library | [`0x91eb19da5A7486b4AAb4a0e452299B7E6F3821F4`](https://snowtrace.io/address/0x91eb19da5A7486b4AAb4a0e452299B7E6F3821F4) | yes |
| Registration verifier | [`0x35b4C4227082f67c01656A39aC47F6c5D6005CaA`](https://snowtrace.io/address/0x35b4C4227082f67c01656A39aC47F6c5D6005CaA) | yes |
| Mint verifier | [`0xb0ea11Bf58ad83F1027E476cbA7B8E196Cc0C972`](https://snowtrace.io/address/0xb0ea11Bf58ad83F1027E476cbA7B8E196Cc0C972) | yes |
| Transfer verifier | [`0x4A716026a0C1F7158165520B6DF2009fFeB79f01`](https://snowtrace.io/address/0x4A716026a0C1F7158165520B6DF2009fFeB79f01) | yes |
| Withdraw verifier | [`0xDf3caC632d70365cEb5CD1DD72E5de741936fdb7`](https://snowtrace.io/address/0xDf3caC632d70365cEb5CD1DD72E5de741936fdb7) | yes |
| Burn verifier | [`0xCb59d38DA7F1E4cA11BfFa6BEd383624fa49bc3d`](https://snowtrace.io/address/0xCb59d38DA7F1E4cA11BfFa6BEd383624fa49bc3d) | yes |
| `PrivateGiftEscrow` | [`0xb22c366e000165683A51C2630F6Ab818e5227C94`](https://snowtrace.io/address/0xb22c366e000165683A51C2630F6Ab818e5227C94) | yes |
| `BenzoCCTPRouter` | [`0x83F26C562082e3c455938fd48162e990494a4caE`](https://snowtrace.io/address/0x83F26C562082e3c455938fd48162e990494a4caE) | yes |

Wrapped assets: **USDC** [`0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`](https://snowtrace.io/address/0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E)
(`tokenId 1`) · **EURC** [`0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD`](https://snowtrace.io/address/0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD)
(`tokenId 2`). Auditor account `0x5ba6F05b245C06c3a4C05e7bC4486dE3661393ea`; its
BabyJubJub private half is a local operator secret and is never committed.

**CCTP onramp — proven end-to-end.** A single **0.1 USDC** burn on Base was
Circle-attested and settled on Avalanche by the relayer (settle tx
[`0xc479b7c8d7a62fde5189d5c03b7f7fe8b5b4ad44afd42eea1aaf194c7556f8a3`](https://snowtrace.io/tx/0xc479b7c8d7a62fde5189d5c03b7f7fe8b5b4ad44afd42eea1aaf194c7556f8a3)),
then credited into an encrypted eERC balance. `BenzoCCTPRouter` allow-lists USDC
and EURC with source maps for Ethereum / Base / Arbitrum / Optimism USDC and
Ethereum / Base EURC. The onramp poller runs as a second backend container. This
is proven by **one** test burn — it is not load-tested or adversarially hardened.

## Deployed on Fuji

The eERC converter stack is deployed on Avalanche Fuji C-Chain (`43113`) and
wraps Circle **testnet** USDC + EURC. Full deployment metadata lives in
[`contracts/deployments/fuji.json`](contracts/deployments/fuji.json). This
testnet path is where the 17/17 real-funds flows run.

| Contract | Address (Fuji) |
| --- | --- |
| `EncryptedERC` converter | [`0x9E16eD3B799541B4929f7E2014904C65E81035b1`](https://testnet.snowtrace.io/address/0x9E16eD3B799541B4929f7E2014904C65E81035b1) |
| `Registrar` | [`0x9a63FEa9851097DBAf3757b636217fdde50ABaF0`](https://testnet.snowtrace.io/address/0x9a63FEa9851097DBAf3757b636217fdde50ABaF0) |
| `BabyJubJub` library | [`0x04513c37Fca1FBABA5Bb6Ff9547658b00B35697B`](https://testnet.snowtrace.io/address/0x04513c37Fca1FBABA5Bb6Ff9547658b00B35697B) |
| Registration verifier | [`0x4250bD1eb89Ef78469f94da2fE7738DCdcb09Ef7`](https://testnet.snowtrace.io/address/0x4250bD1eb89Ef78469f94da2fE7738DCdcb09Ef7) |
| Mint verifier | [`0x0fE395F5E97Ee02c961DE3d035E5De2D9019D15E`](https://testnet.snowtrace.io/address/0x0fE395F5E97Ee02c961DE3d035E5De2D9019D15E) |
| Transfer verifier | [`0x4bF3DBD3fF57943dC402ec1F280589E1032A32A5`](https://testnet.snowtrace.io/address/0x4bF3DBD3fF57943dC402ec1F280589E1032A32A5) |
| Withdraw verifier | [`0x7E194cb8A575d23f74EEDbEf1b519B281B29c30e`](https://testnet.snowtrace.io/address/0x7E194cb8A575d23f74EEDbEf1b519B281B29c30e) |
| Burn verifier | [`0x1BDfD6cB772D5F882622BaFD7B19898Da9F61d34`](https://testnet.snowtrace.io/address/0x1BDfD6cB772D5F882622BaFD7B19898Da9F61d34) |
| USDC (wrapped, `tokenId 1`) | [`0x5425890298aed601595a70AB815c96711a31Bc65`](https://testnet.snowtrace.io/address/0x5425890298aed601595a70AB815c96711a31Bc65) |
| EURC (wrapped, `tokenId 2`) | [`0x5E44db7996c682E92a960b65AC713a54AD815c6B`](https://testnet.snowtrace.io/address/0x5E44db7996c682E92a960b65AC713a54AD815c6B) |

The Fuji auditor account recorded in the deployment manifest is
`0x13b8d12414dd468a9eCbA24d0a162C17affd6D32`. Its BabyJubJub private key is a
local operator secret and must never be committed.

## Deployed on BenzoNet L1 — the bonus combo, proven

BenzoNet is Benzo's own permissioned Avalanche L1 (Subnet-EVM, chain id `68420`,
gas token BGAS). The **same eERC converter stack** is deployed on it, so encrypted
eERC amounts move **inside** a gated chain — the Speedrun's explicit bonus
(encrypted amounts *and* gated access at once). It is a **testnet** L1 (single
validator, funded ~3 weeks); no mainnet BenzoNet is deployed. Public RPC:
`https://rpc.benzo.space` · explorer: [explorer.benzo.space](https://explorer.benzo.space)
· full manifest: [`contracts/deployments/benzonet.json`](contracts/deployments/benzonet.json).

| Contract | Address (BenzoNet `68420`) |
| --- | --- |
| `EncryptedERC` converter | [`0xEE46418e5EeFE6f74EFaa9beb370B59251BFFb02`](https://explorer.benzo.space/address/0xEE46418e5EeFE6f74EFaa9beb370B59251BFFb02) |
| `Registrar` | [`0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d`](https://explorer.benzo.space/address/0x0B1f4e78C54E7696663b62F9cD7956f5FDE5b71d) |
| `TestUSDC` (`tUSDC`, `tokenId 1`) | [`0x25B6a6bcF1aea52CE27A302E521aF9dBDD27D2E7`](https://explorer.benzo.space/address/0x25B6a6bcF1aea52CE27A302E521aF9dBDD27D2E7) |
| `BabyJubJub` library | [`0xbADeF08FE085928c36cF1301CfAa4d8061DA2469`](https://explorer.benzo.space/address/0xbADeF08FE085928c36cF1301CfAa4d8061DA2469) |
| tx-allowlist precompile | `0x0200000000000000000000000000000000000002` |

**Live proof (reproducible on the public RPC):**

1. **Confidential transfer** — a private eERC transfer with the amount encrypted
   on-chain (Groth16), decrypt-verified against the sender/receiver balances, has
   been run on BenzoNet.
   - Reproduce: `PRIVATE_KEY=<deployer> PRIVATE_KEY_2=<ops> BENZONET_RPC_URL=https://rpc.benzo.space npx hardhat run scripts/deploy/benzonet-confidential-demo.ts --network benzonet`
2. **Gated access** — a funded but non-allow-listed wallet is rejected at the
   tx-allowlist precompile before its tx reaches a block (*"cannot issue
   transaction from non-allow listed address"*). Only an Admin/Manager
   (`benzo-ops`) can Enable a wallet — the gated-onboarding step.
   - Reproduce: `PRIVATE_KEY=<deployer> BENZONET_RPC_URL=https://rpc.benzo.space npx hardhat run scripts/deploy/benzonet-gated-access-demo.ts --network benzonet`

Together these are the two privacy primitives stacked on one chain: eERC hides the
*amounts*, the permissioned L1 walls off *who can transact* — encrypted value
moving inside a gated, auditor-ready chain.

## Mainnet Status — live

Benzo is **live on the Avalanche C-Chain mainnet (`43114`)**. The full eERC
converter stack (10 contracts) is deployed and wrapping **real Circle USDC**
(`tokenId 1`) and EURC (`tokenId 2`), the production Groth16 phase-2 ceremony is
complete, the auditor key is set on-chain, and the CCTP onramp has been proven
end-to-end with a real cross-chain burn. Addresses are in the
[mainnet table above](#deployed-on-avalanche-mainnet--live); the full go/no-go
record is in [`docs/MAINNET_GO_NO_GO.md`](docs/MAINNET_GO_NO_GO.md).

Mainnet is **C-Chain converter only** — BenzoNet stays testnet-only and no mainnet
BenzoNet is deployed. This is a fresh deployment and is **not** yet
production-hardened; see "What remains" below.

**How it got here: config vs. new work.**

| Category | What it covered | Status |
| --- | --- | --- |
| **Pure config** | RPC `https://api.avax.network/ext/bc/C/rpc`, explorer `snowtrace.io`, chainId `43114`; CCTP domain unchanged (Avalanche = `1`); attestation base sandbox → prod (`iris-api.circle.com`); separate prod secrets (`APP_MASTER_KEY`, `OPS_PRIVATE_KEY`, deployer, auditor, `DATABASE_URL`). | Cut over at deploy |
| **New code (shipped + exercised on testnet)** | Token-agnostic per-network deploy, the `avalanche` network wiring, and the guard-railed `deploy:mainnet` command. | Deployed to mainnet |
| **New crypto (the hard part)** | A multi-machine Groth16 phase-2 ceremony to replace the dev (`contributions:0`) verifiers. | **Done — 3-machine contribution chain + public drand beacon (round 30261477); verifiers regenerated, marker flipped to `build:"ceremony"`, browser proving keys re-coupled. Transcript: [`docs/ceremony/transcript.md`](docs/ceremony/transcript.md)** |

**Circle / CCTP V2 mainnet addresses (external Circle contracts).**

| Thing | Address (Avalanche C-Chain `43114`) |
| --- | --- |
| USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| EURC | `0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD` |
| CCTP `TokenMessengerV2` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP `MessageTransmitterV2` | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |

The mainnet converter wraps **real Circle USDC** (never a `TestUSDC`), pinned to
`tokenId 1`. The deploy ran through `pnpm --filter @benzo/contracts deploy:mainnet`,
which sends no transaction unless every guardrail passes (confirm flag, chainId
`43114`, existing-USDC wrapping, a **ceremony** verifier build, distinct
deployer/auditor keys, a funded deployer, and an operator-provided auditor key).

**What remains (honest post-deploy work).**

- **Admin is still the hot deploy key.** The `Ownable` admin across the mainnet
  contracts is the deployer (`0x09b6…9846`); it has **not** been transferred to a
  multisig or cold wallet. That transfer is the top post-deploy item.
- **Onramp is single-test-proven.** The CCTP onramp is proven by **one** 0.1 USDC
  Base→Avalanche burn (settle tx `0xc479b7c8…f8a3`). It is not load-tested,
  fuzzed, or adversarially hardened, and it is not audited.
- **Source-verified on Snowtrace.** Per the deployment manifest, all ten mainnet
  contracts are source-verified on Snowtrace (see the Verified column in the
  mainnet table).
- **Ceremony trust model.** The phase-2 ceremony was a single-coordinator, 3-machine
  run — not an open multi-party ceremony. Its soundness rests on the published,
  re-verifiable transcript plus the unbiasable drand beacon, not on a large set of
  independent external participants.
- **W3 is reveal-and-verify, not a ZK disclosure circuit.** Selective disclosure /
  proof-of-payment reveals the underlying values and verifies them; it is **not** a
  zero-knowledge disclosure proof. That limitation is intentional and stated
  plainly rather than dressed up.

## Repository Layout

This repository holds the Benzo backend and infrastructure. The end-user apps
live in their own repositories.

```text
contracts/       Hardhat workspace: eERC, verifiers, Benzo registries, deployment manifests (fuji / avalanche / benzonet)
services/api/    Fastify + Postgres service for auth, onboarding, activity, org workflows
infra/           BenzoNet genesis, deployed L1 metadata, edge/Caddy topology, smoke tests
packages/config/ Shared chain defs, deployed addresses, and circuit URL helpers
assets/readme/   README banner and brand marks
```

| App | Repository |
| --- | --- |
| Consumer wallet (mobile-first) | [`Miny-Labs/benzo-wallet`](https://github.com/Miny-Labs/benzo-wallet) |
| Business console (desktop-first) | [`Miny-Labs/benzo-console`](https://github.com/Miny-Labs/benzo-console) |
| BenzoNet block explorer | [`Miny-Labs/benzo-explorer`](https://github.com/Miny-Labs/benzo-explorer) |

## Five-Minute Quickstart

Prerequisites: Node.js 22+, pnpm, and Docker for the API test suite.

```bash
pnpm install && pnpm compile && pnpm --filter @benzo/contracts zkit:make && pnpm test
```

That installs the workspace, compiles the contracts, generates ignored local
zkit artifacts for the proof-heavy contract tests, and runs the test suites.
After `contracts/zkit/` exists locally, the shorter loop is:

```bash
pnpm install && pnpm compile && pnpm test
```

No Fuji private key is needed for the quickstart. Deployment and smoke commands
that touch Fuji or BenzoNet require operator-held keys and are documented in
[`contracts/README.md`](contracts/README.md) and
[`infra/README.md`](infra/README.md).

## Testing

Three tiers, all config-driven off `@benzo/config` so mainnet is a manifest swap:

- **Unit / default** — `pnpm test`. Fundless, no network; the Fuji-fork and funded
  tiers self-skip here so this stays fast and green.
- **TIER 1 — Fuji-fork integration** (`.github/workflows/fuji-fork.yml`, runs on
  every PR + push). `FORK=fuji pnpm --filter @benzo/contracts test` forks Fuji at
  a pinned block and exercises `BenzoCCTPRouter` against **real** Circle USDC +
  the real CCTP `TokenMessenger` bytecode (happy path, fee-shortfall, duplicate
  message, unregistered recipient). Fundless — no secrets, no keys.
- **TIER 2 — funded live-testnet e2e** (`tests/e2e`, `@benzo/e2e`;
  `.github/workflows/e2e-live.yml`, nightly + manual, **not** a required check).
  Real testnet funds. Every suite self-skips unless `RUN_LIVE_E2E=1` and its
  funded accounts (`BENZO_ONRAMP_USER_KEY` / `BENZO_RELAYER_KEY` / …) are present
  and funded — a missing/underfunded account turns into a precise `Fund 0x… on
  fuji …` skip, never a failure. Suites: `eerc-core`, `cctp-onramp`, `disclosure`,
  `payroll-batch`, `auditor-rotate`, `benzonet-gating`. A concurrency group
  serializes runs so they never race the relayer nonce. Run locally with
  `RUN_LIVE_E2E=1 pnpm --filter @benzo/e2e test`.

No address is ever hard-coded in a test body — everything resolves from the
`@benzo/config` deployment manifest, so pointing a tier at mainnet is a config
change, not a code change. See `.env.example` for the testnet-only variables.

## License

Benzo is Apache-2.0. The vendored
[`ava-labs/EncryptedERC`](contracts/contracts/eerc/VENDOR.md) code keeps its
upstream attribution and is licensed under the Ava Labs Ecosystem License v1.1;
its use is limited to Avalanche platforms and non-commercial testing/research
inside the Avalanche ecosystem.
