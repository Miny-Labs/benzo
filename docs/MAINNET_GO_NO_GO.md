# Mainnet Go / No-Go

Benzo's mainnet cutover is a **paused gate**. This document is the single checklist
that must be green before any Avalanche C-Chain (`43114`) deploy, and the honest
account of what is a config flip versus genuinely new work.

**Standing rule: nothing broadcasts to Avalanche mainnet until every box below is
checked.** Everything shipped in Milestone M5 is *built + fork-dry-run only*. The
`deploy:mainnet` command is designed to refuse — it sends no transaction unless all
guardrails pass, and today they cannot (the verifiers are a dev trusted setup).

Mainnet is **C-Chain converter only**. BenzoNet (the permissioned L1, chain id
`68420`) is **excluded from mainnet** and stays testnet-only.

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

### New crypto — the one hard, unstarted part

- **Production Groth16 ceremony.** The verifiers on Fuji come from a dev trusted
  setup (`contributionSettings.contributions: 0`) and MUST NOT back mainnet. A real
  multi-operator phase-2 ceremony + public random beacon + published transcript has
  to regenerate all five verifiers. This is genuine coordination work that has not
  been done.

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
no block mined). The happy path is reachable only on a C-Chain fork with a real
ceremony build in place.

### The ceremony marker (#121)

`contracts/scripts/ceremony/ceremony-marker.json` records, per circuit, the sha256 of the
verifier `.sol` that a given trusted setup produced, plus `build` (`dev` vs
`ceremony`), the contribution count, and the beacon. Today it is `build: "dev"`, so
guardrail #4 fails. `scripts/ceremony/run-ceremony.ts` is the operator tooling that
runs the real ceremony and rewrites the marker to `build: "ceremony"`.
**Deliberately not run here:** the multi-hour, multi-operator ceremony would desync
the committed Fuji verifiers and needs real independent operators — it is the final
pre-mainnet operational step.

---

## Go / No-Go checklist

Each box maps to an M5 issue (#120 wiring + guardrails, #121 ceremony, #122 docs).

- [ ] **Production ceremony done** — all five verifiers regenerated from a ceremony
      with `contributions > 0` and a documented public beacon; transcript published;
      ceremony marker flipped to `build: "ceremony"`. *(#121)*
- [ ] **Deploy code proven on Fuji wrapping REAL Circle USDC** — the token-agnostic
      converter deploy runs against real Circle USDC (not `TestUSDC`), `isConverter()`
      is true, and deposit → transfer → withdraw round-trips. *(#120)*
- [ ] **CCTP router + deposit-on-behalf proven on testnet** — one-tap cross-chain
      deposit lands into the converter on the user's behalf. *(#120, prior milestones)*
- [ ] **`avalanche.json` manifest populated + config parity test green** — real
      deployed addresses written to `contracts/deployments/avalanche.json` and
      `packages/config/src/deployments/avalanche.json`; the `placeholder` flag removed;
      `@benzo/config` check passes. *(#120)*
- [ ] **Separate prod secrets + DB provisioned** — distinct prod `APP_MASTER_KEY`,
      `OPS_PRIVATE_KEY`, deployer, auditor, and a non-local `DATABASE_URL`. *(#120)*
- [ ] **Deployer funded with mainnet AVAX** — above the `deploy:mainnet` balance
      floor. *(#120)*
- [ ] **Auditor key custodied + sealed** — the mainnet auditor BabyJubJub key is
      operator-provided, its private half sealed in the prod store (never in
      `contracts/.auditor-key.local.json`), and a rotation rehearsed on Fuji. *(#120)*
- [ ] **All `deploy:mainnet` guardrails pass in a fork dry-run** — on a C-Chain fork,
      every guardrail is green and the deploy completes without touching mainnet. *(#120)*
- [ ] **Contracts source-verified on `snowtrace.io` post-deploy** — via the Routescan
      mainnet path. *(#120)*

---

## Honest limitations to keep stating

- **The production trusted setup is a hard prerequisite**, not a formality. Until the
  ceremony is done and the verifiers rotated, mainnet is a no-go.
- **The eERC deposit-on-behalf patch behind CCTP one-tap** is a real code path
  (proven on testnet), not a config value.
- **W3 (selective disclosure / proof-of-payment) is reveal-and-verify**, not a
  zero-knowledge disclosure circuit: it reveals the underlying values and verifies
  them on-chain. This is intentional and is stated plainly rather than overclaimed.
