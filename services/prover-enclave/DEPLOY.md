# Benzo prover enclave — deploy / upgrade / kill runbook

The business (managed-service) side of Benzo proves its ZK on an attested Phala
dstack (Intel TDX) CVM: the witness is sealed to the enclave's attested X25519
key, proven inside the TEE, and only the proof leaves. Soundness is identical to
local proving (proofs verify on-chain either way) — the TEE only protects WHERE
the witness is handled.

All org circuits are baked into the image (`services/prover-enclave/src/prove.mjs`
`CIRCUITS` + `scripts/stage-artifacts.sh`): `proof_of_sum_org`,
`proof_of_balance_org`, `spending_cap`, `payout_innocence`, `payroll_computation`,
`org_spend_auth`, `kyb_credential`, `cross_netting`, `joinsplit_org` (plus the
consumer `shield`/`joinsplit`/`unshield`/`kyc_credential`/`funds_attestation`).

Verified: `tests/e2e/tee-org-circuits.mjs` drives the enclave's exact proving core
over the baked org artifacts and verifies the proof ON-CHAIN (cross_netting ->
NETTING = true). The attested transport (PhalaProver + dcap-qvl quote) is proven
by `tests/e2e/tee-onchain.mjs`.

## Build + push the image (requires `docker login ghcr.io` with a PAT)

> ⚠️ The Phala TDX CVM is **linux/amd64**. On an Apple Silicon / arm64 host you
> MUST cross-build for amd64 — a plain `docker build` produces an arm64 image that
> boots fine locally but dies instantly on the CVM (container → `stopped`, no logs).

```bash
bash services/prover-enclave/scripts/stage-artifacts.sh        # stage all circuit artifacts (~242M)
cd services/prover-enclave
# Cross-build + push for the CVM's architecture in one step:
docker buildx build --platform linux/amd64 -t ghcr.io/akash-mondal/benzo-prover:v4 --push .
docker manifest inspect ghcr.io/akash-mondal/benzo-prover:v4 | grep architecture   # must show amd64
```

Then bump the image tag in `deploy/phala/docker-compose.yml` (`:v3` -> `:v4`).

## Upgrade the live CVM (new compose-hash = new measurement)

```bash
phala cvms list                                                # current: app f660b9588…, cvm benzo-prover-enclave
phala cvms upgrade f660b9588fd8ceae268440f5a28c3bd7e9604c50 \
  -c deploy/phala/docker-compose.yml
phala cvms list                                                # note the new compose-hash
```

Pin the new measurement so the console attests it:

```bash
# .env (console-api / business side)
BENZO_PROVER_MODE=tee
BENZO_PROVER_ENDPOINT=https://<app-id>-8080.<node>.phala.network
BENZO_PROVER_MEASUREMENT=<new compose-hash>
BENZO_PROVER_TCB=UpToDate          # optional; defaults inside DstackAttestationVerifier
```

`apps/console-api/src/chain.ts` builds its prover with `proverFromEnv()`, so the
console proves all org circuits on the attested CVM the moment these are set — no
code change. With the vars unset it falls back to local `NodeProver` (same proofs,
same on-chain verification).

## Verify live

```bash
set -a; . ./.env; set +a
node tests/e2e/tee-onchain.mjs        # attested PhalaProver -> proof -> verify_proof on-chain
```

## Kill the CVM (when done)

```bash
phala cvms delete f660b9588fd8ceae268440f5a28c3bd7e9604c50
phala cvms list                        # confirm removed
```

> Note: `joinsplit_org` (2^18, ~71M zkey) is the heaviest baked circuit and can be
> slow/flaky on the CVM; the smaller org circuits (spending_cap, cross_netting,
> proof_of_*_org, payroll_computation, kyb_credential, org_spend_auth) are
> TEE-friendly. Settlement (`transfer_org`) also works via the local NodeProver
> path; the TEE is for witness-hiding proofs.
