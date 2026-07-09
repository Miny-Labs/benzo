# Mainnet Go / No-Go

Benzo's mainnet go/no-go was **executed on 2026-07-09**: every gate below passed and
the Avalanche C-Chain (`43114`) deploy went live. This document is the record of that
decision — the checklist annotated with outcomes, the honest account of what was a
config flip versus genuinely new work, and the post-deploy items that remain.

**Outcome: GO (2026-07-09).** The Groth16 ceremony completed, the `deploy:mainnet`
guardrails passed on a C-Chain fork dry-run, the deploy broadcast, and the CCTP onramp
was proven end-to-end with a real cross-chain burn. The `deploy:mainnet` command still
refuses to send a transaction unless every guardrail passes — on 2026-07-09 they all
did (the verifiers are now a real **ceremony** build, not the dev setup).

Mainnet is **C-Chain converter only**. BenzoNet (the permissioned L1, chain id
`68420`) is **excluded from mainnet** and stays testnet-only.

### Deployed mainnet addresses (source of truth)

Full manifests: [`contracts/deployments/avalanche.json`](../contracts/deployments/avalanche.json)
and [`packages/config/src/deployments/avalanche.json`](../packages/config/src/deployments/avalanche.json);
human-readable cross-network table in [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

| Contract | Address (`43114`) |
| --- | --- |
| `EncryptedERC` converter | `0x708d0b83461973F46041a36f588b8760dbC0Db0e` |
| `Registrar` | `0x902B8D5585A5124C9B9c001A95b7f520C07a79F2` |
| `BabyJubJub` | `0x91eb19da5A7486b4AAb4a0e452299B7E6F3821F4` |
| registration / mint / transfer / withdraw / burn verifiers | `0x35b4C4…5CaA` / `0xb0ea11…C972` / `0x4A7160…9f01` / `0xDf3caC…fdb7` / `0xCb59d3…9bc3d` |
| `PrivateGiftEscrow` | `0xb22c366e000165683A51C2630F6Ab818e5227C94` |
| `BenzoCCTPRouter` | `0x83F26C562082e3c455938fd48162e990494a4caE` |
| USDC (`tokenId 1`) / EURC (`tokenId 2`) | `0xB97EF9Ef…48a6E` / `0xC891EB4c…c2ACD` |
| Auditor account | `0x5ba6F05b245C06c3a4C05e7bC4486dE3661393ea` |
| Deployer / current `Ownable` admin | `0x09b67991141146e2A43651C72CF6786eeb579846` |

Ceremony: Groth16 phase-2, drand quicknet **round 30261477**, transcript
[`ceremony/transcript.md`](ceremony/transcript.md). CCTP onramp settle tx:
`0xc479b7c8d7a62fde5189d5c03b7f7fe8b5b4ad44afd42eea1aaf194c7556f8a3`.

---

## Why mainnet is mostly a config flip

Benzo was built config-driven from the start: every address resolves from
`@benzo/config` / the deployment manifests, and networks are keyed by a `staging`
(testnet) vs `production` (mainnet) tier. So the majority of the cutover is data,
not code.

### Pure config (flip at cutover — no new code)

| Item | Testnet (staging) | Mainnet (production) |
| --- | --- | --- |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` | `https://api.avax.network/ext/bc/C/rpc` |
| Explorer | `testnet.snowtrace.io` | `snowtrace.io` |
| chainId | `43113` | `43114` |
| CCTP domain | `1` | `1` (unchanged — a domain is chain-*family*) |
| CCTP `TokenMessengerV2` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP `MessageTransmitterV2` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| USDC | `0x5425890298aed601595a70AB815c96711a31Bc65` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| EURC | `0x5E44db7996c682E92a960b65AC713a54AD815c6B` | `0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD` |
| Attestation base | `iris-api-sandbox.circle.com` | `iris-api.circle.com` |
| Secrets | staging `APP_MASTER_KEY` / `OPS_PRIVATE_KEY` / deployer / auditor / `DATABASE_URL` | **separate** prod values for each |

Separate prod secrets are enforced by the backend config, not just convention: a
blob sealed with the staging `APP_MASTER_KEY` cannot be unsealed with the prod key
(AES-256-GCM tag mismatch), and `CHAIN_ENV=avalanche` pointed at Fuji addresses
throws at startup.

### New code — already shipped on testnet (this milestone)

- **Token-agnostic per-network deploy** — the converter wraps whatever each network
  declares; mainnet wraps real Circle USDC, never a `TestUSDC`.
- **`avalanche` network wiring** — `hardhat.config.ts` network + Routescan mainnet
  verification path; `eerc-deployments.ts` chainId guard, `snowtrace.io` links, and
  a `{fuji, avalanche}` verify set (the BenzoNet Blockscout path is unchanged).
- **Guard-railed `deploy:mainnet`** — a single command that refuses to proceed
  unless every guardrail passes (see below).

### New crypto — the hard part (now done)

- **Production Groth16 ceremony — complete (2026-07-09).** The dev verifiers
  (`contributionSettings.contributions: 0`) were replaced by a real phase-2 ceremony:
  three sequential contributions on separate ephemeral machines, sealed with the
  public drand quicknet beacon (round 30261477); all five verifiers regenerated and
  the browser proving keys re-coupled. Transcript: [`ceremony/transcript.md`](ceremony/transcript.md).
  It was a single-coordinator, 3-machine run rather than an open multi-party ceremony
  — its soundness rests on the published, re-verifiable transcript plus the unbiasable
  beacon, not on a large set of independent external participants.

---

## The `deploy:mainnet` guardrails

`pnpm --filter @benzo/contracts deploy:mainnet` (→ `scripts/deploy/deploy-mainnet.ts`,
guardrails in `scripts/deploy/mainnet-guardrails.ts`) aborts non-zero, **sending no
transaction**, on any of:

1. `MAINNET_CONFIRM=1` missing (checked first, before any RPC read).
2. RPC chainId ≠ `43114`.
3. Any wrapped token is `deploy-test`, or USDC is not the existing mainnet USDC.
4. The verifiers are not a **ceremony** build (asserted against the committed
   ceremony marker — see #121 below).
5. `PRIVATE_KEY` (deployer) equals `PRIVATE_KEY_2` (auditor), or either is missing.
6. Deployer AVAX balance is below the floor.
7. The mainnet auditor key is not operator-provided (`MAINNET_AUDITOR_PUBKEY`);
   the deploy never auto-generates it.

Proven by `contracts/test/benzo/MainnetGuardrails.test.ts` (each guardrail → abort,
no block mined). On 2026-07-09 all seven passed on a C-Chain fork dry-run with the
real ceremony build in place, and the guarded deploy then ran against mainnet.

### The ceremony marker (#121)

`contracts/scripts/ceremony/ceremony-marker.json` records, per circuit, the sha256 of the
verifier `.sol` that a given trusted setup produced, plus `build` (`dev` vs
`ceremony`), the contribution count, and the beacon. It is now `build: "ceremony"`
(drand round 30261477), so guardrail #4 passes. `scripts/ceremony/run-ceremony.ts`
is the operator tooling that ran the real ceremony and rewrote the marker; the
regenerated verifiers were deployed to both Fuji and mainnet, and the transcript is
published at [`ceremony/transcript.md`](ceremony/transcript.md).

---

## Go / No-Go checklist — executed 2026-07-09

Each box maps to an M5 issue (#120 wiring + guardrails, #121 ceremony, #122 docs).
Outcomes are annotated inline; unchecked boxes are the remaining post-deploy work.

- [x] **Production ceremony done** — all five verifiers regenerated from a phase-2
      ceremony (three ephemeral-machine contributions + drand quicknet **round
      30261477**); transcript published at `ceremony/transcript.md`; ceremony marker
      flipped to `build: "ceremony"`. *(#121)*
- [x] **Deploy code proven on Fuji wrapping REAL Circle USDC** — the token-agnostic
      converter wraps Circle testnet USDC (`0x5425…Bc65`) on Fuji, `isConverter()` is
      true, deposit → transfer → withdraw round-trips (17/17 real-funds flows). *(#120)*
- [x] **CCTP router + deposit-on-behalf proven on testnet** — one-tap cross-chain
      deposit lands into the converter on the user's behalf; re-proven on mainnet by a
      0.1 USDC Base→Avalanche burn (settle tx `0xc479b7c8…f8a3`). *(#120, prior milestones)*
- [x] **`avalanche.json` manifest populated + config parity** — real deployed
      addresses written to `contracts/deployments/avalanche.json` and
      `packages/config/src/deployments/avalanche.json` (tier `production`); no
      `placeholder` flag. *(#120)*
- [x] **Separate prod secrets + DB provisioned** — distinct prod `APP_MASTER_KEY`,
      `OPS_PRIVATE_KEY`, deployer (`0x09b6…9846`), auditor (`0x5ba6…93ea`, distinct
      from the deployer), and a non-local `DATABASE_URL`. *(#120)*
- [x] **Deployer funded with mainnet AVAX** — above the `deploy:mainnet` balance floor
      (the deploy broadcast successfully). *(#120)*
- [x] **Auditor key custodied + sealed** — the mainnet auditor BabyJubJub key is
      operator-provided and set on-chain (account `0x5ba6…93ea`); its private half is a
      local operator secret, never committed. *(#120)*
- [x] **All `deploy:mainnet` guardrails pass in a fork dry-run** — on a C-Chain fork,
      all seven guardrails were green; the deploy then ran against mainnet. *(#120)*
- [x] **Contracts source-verified on `snowtrace.io` post-deploy** — **complete.** All
      ten mainnet contracts (the converter, `Registrar`, all five verifiers, `BabyJubJub`,
      `PrivateGiftEscrow`, and `BenzoCCTPRouter`) are source-verified on Snowtrace and
      carry a `verifiedAt` in the manifest. *(#120)*

### Remaining post-deploy items

- [ ] **Transfer `Ownable` admin off the hot deploy key.** Admin is still the deployer
      (`0x09b67991141146e2A43651C72CF6786eeb579846`); move it to a multisig / cold
      wallet. **Top priority.**
- [x] **Finish Routescan source-verification** — all ten mainnet contracts are now
      source-verified on Snowtrace and the manifest `verified` flags are updated.
- [ ] **Harden the CCTP onramp beyond the single test burn** — load, failure-injection,
      and adversarial testing before treating the onramp as production-grade.

---

## Honest limitations to keep stating

- **This is a fresh, unaudited deployment.** The `Ownable` admin is still the hot
  deploy key; until it is moved to a multisig / cold wallet, a single compromised key
  controls the mainnet contracts. That transfer is the top post-deploy item.
- **The ceremony was single-coordinator, not open multi-party.** Its trust rests on
  the published, re-verifiable transcript plus the unbiasable drand beacon — not on a
  large set of independent external participants.
- **The CCTP onramp is proven by one 0.1 USDC test burn**, not load-tested or
  adversarially hardened. The eERC deposit-on-behalf patch behind CCTP one-tap is a
  real code path, not a config value.
- **W3 (selective disclosure / proof-of-payment) is reveal-and-verify**, not a
  zero-knowledge disclosure circuit: it reveals the underlying values and verifies
  them on-chain. This is intentional and is stated plainly rather than overclaimed.
