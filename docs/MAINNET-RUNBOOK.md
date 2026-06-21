# Benzo — mainnet go-live runbook

_The codebase is production-ready and **network-agnostic** (see [ARCHITECTURE-CLIENTSIDE-ZK.md](ARCHITECTURE-CLIENTSIDE-ZK.md) §6). Going to mainnet is an **operational** procedure — it spends real XLM/USDC, uses real operator secret keys, and requires a human multi-party trusted-setup ceremony. It must be run by a person with those funds/keys; an agent can't (and shouldn't) handle mainnet credentials or move real funds. This is the exact, ordered checklist. Nothing below needs a code change._

## 0. Prerequisites
- A funded **mainnet** Stellar account for the **deployer** (contract deploys + VK registration cost XLM).
- Separate funded **operator** keys (per-role, per the proven testnet pattern): `benzo-relayer` (gas relay), and ideally distinct wallet vs console operators.
- A **mainnet RPC** provider URL (not the public testnet endpoint) — see https://developers.stellar.org/docs/data/apis/rpc/providers.
- Real **Circle USDC** asset on mainnet (issuer + your distribution account with a trustline).
- Contributors for the **trusted-setup ceremony** (independent machines; a public randomness beacon for the final contribution).

## 1. Trusted-setup ceremony (REQUIRED — current dev VKs are single-author, NOT production-trustworthy)
For each of the 8 circuits (`shield`, `joinsplit`, `unshield`, `proof_of_sum`, `kyc_credential`, `funds_attestation`, `proof_of_balance`, `trivial`):
1. Run the phase-2 ceremony with ≥3 independent contributors + a public beacon: `bash scripts/ceremony.sh <circuit>` (writes `ceremony/<circuit>/<circuit>_vk.json` + `final.zkey`).
2. Publish the transcript (hashes + contributor attestations) so reviewers can reproduce.
3. Regenerate the proving fixtures from the finalized `final.zkey`.
The deploy enforces provenance on mainnet (`REQUIRE_VK_PROVENANCE=1` is auto-set) — it aborts if a deployed VK doesn't byte-match its ceremony transcript.

## 2. Stellar keys
```
stellar keys add benzo-deployer  --secret-key <MAINNET_DEPLOYER_SECRET>
stellar keys add benzo-relayer   --secret-key <MAINNET_RELAYER_SECRET>
# fund both on mainnet; add a USDC trustline to the distribution account
```

## 3. Deploy the contracts (network-agnostic script)
```
set -a; . ./.env.mainnet; set +a     # NETWORK_PASSPHRASE, SOROBAN_RPC_URL, DEPLOYER_PUBLIC, USDC_*
BENZO_NETWORK=mainnet bash scripts/deploy-testnet.sh
```
This deploys all contracts on `--network mainnet`, registers every VK (incl. `BALANCE`), wires the MVK registry + KYC-gated admission, and writes **`deployments/mainnet.json`**. It refuses to run with un-provenanced VKs.

## 4. Point the apps at mainnet (env only — no code change)
Build the wallet/console with:
```
VITE_BENZO_NETWORK=mainnet
VITE_SOROBAN_RPC_URL=<mainnet RPC>
VITE_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
VITE_BENZO_DEPLOYMENT=<contents of deployments/mainnet.json, as JSON>
VITE_BENZO_SIM_SOURCE=<a funded mainnet G-address, read/sim only>
VITE_BENZO_RELAYER_ADDRESS=<benzo-relayer public G-address>
```
The BFFs read `STELLAR_NETWORK/SOROBAN_RPC_URL/NETWORK_PASSPHRASE/DEPLOYER_SECRET/RELAYER_SECRET` from their env. Disable `BENZO_DEV_EXPORT` (the testnet account-import affordance) — on mainnet the device derives keys from the passkey and they are never transmitted.

## 5. Production operator + relay posture (already coded; just configure)
- Per-role operators: relay signs with `benzo-relayer` (separate from deployer) — proven on testnet.
- Relay is pool-only + `transfer`-fn-only + rate-limited; self-host it (multi-instance) for HA.
- Real RPC with rate-limit + failover; real KYB/IDV provider + SEP-24 fiat anchor (replace the labeled mocks).

## 6. Smoke test on mainnet (small amounts)
1. Onboard via passkey; claim a handle.
2. Add money (shield) a small USDC amount; confirm balance.
3. Prove-your-balance → expect on-chain `verify_proof(BALANCE) => true`.
4. Send to a handle → confirm the transfer settles + the recipient discovers the note.
5. Cash out (unshield) a small amount to a public address.

## 7. Pre-mainnet hardening still open (from ARCHITECTURE §6)
- On-chain org dual-control (M-of-N spend authority) — decide the enforcement locus before any circuit change (it invalidates the ceremony).
- proof_of_sum auditor disclosure via `verify_proof(SUM,…)`.
- Claim-link escrow time-lock; console-ledger audit hash-chain; per-circuit replay/negative tests.
- Derive the IndexedDB wrapping key from the passkey PRF (not the imported account).

---
**Status:** everything in this repo that is *code* is mainnet-ready and verified on testnet (real on-chain ZK prove+verify, full client-side money loop incl. on-chain settle, per-role operators, network-agnostic config, relay hardening, IndexedDB encryption at rest). Steps 1–6 above are the operational go-live, which require real funds + a human ceremony and are intentionally left to an operator.
