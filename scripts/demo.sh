#!/usr/bin/env bash
# One-shot Benzo demo against the ALREADY-DEPLOYED testnet contracts in
# deployments/testnet.json — NO redeploy. Prints every tx so you (and judges)
# can open them on Stellar Expert. This is the script the demo video follows.
#
# Prereq: a funded .env (run scripts/setup-testnet-env.sh, then fund the deployer
# with testnet USDC). Contracts are already deployed; to redeploy fresh instead,
# run scripts/deploy-testnet.sh.
#
# Usage:
#   bash scripts/demo.sh              # core demo: flow + compliance + admission
#   bash scripts/demo.sh all         # also corridor + (if configured) TEE→on-chain
#   bash scripts/demo.sh flow        # a single leg: flow|compliance|admission|corridor|tee
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "✗ no .env — run: bash scripts/setup-testnet-env.sh"; exit 1; }
set -a; . ./.env; set +a
export STELLAR_NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:?load .env first}"

hr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
node -e 'const d=require("./deployments/testnet.json");console.log("Deployed on testnet:\n  pool      "+d.pool+"\n  verifier  "+d.verifier+"\n  asp       "+d.aspMembership+"\n  issuerReg "+d.issuerRegistry+(d.tee?"\n  TEE       "+d.tee.endpoint:""))' 2>/dev/null || true

want="${1:-core}"
run() { hr "$1"; ( cd tests && node "e2e/$2" ); }

case "$want" in
  flow)       run "M1 — shield → private transfer → unshield"        m1-flow.mjs ;;
  compliance) run "M2 — MVK/TVK disclosure + ASP both gates"         m2-compliance.mjs ;;
  admission)  run "Tiered-KYC admission (kyc_credential, on-chain)"  admission.mjs ;;
  corridor)   run "M3 — SEP-24 corridor (fiat-sim → … → fiat-sim)"   m3-corridor.mjs ;;
  tee)        run "TEE → on-chain (proof generated in the attested enclave)" tee-onchain.mjs ;;
  core)
    run "M1 — shield → private transfer → unshield"       m1-flow.mjs
    run "M2 — MVK/TVK disclosure + ASP both gates"        m2-compliance.mjs
    run "Tiered-KYC admission (kyc_credential, on-chain)" admission.mjs
    ;;
  all)
    run "M1 — shield → private transfer → unshield"       m1-flow.mjs
    run "M2 — MVK/TVK disclosure + ASP both gates"        m2-compliance.mjs
    run "Tiered-KYC admission (kyc_credential, on-chain)" admission.mjs
    run "M3 — SEP-24 corridor (fiat-sim → … → fiat-sim)"  m3-corridor.mjs
    if [ -n "${BENZO_PROVER_ENDPOINT:-}" ]; then
      run "TEE → on-chain (proof generated in the attested enclave)" tee-onchain.mjs
    else
      hr "TEE → on-chain (skipped: set BENZO_PROVER_ENDPOINT to the live CVM URL)"
    fi
    ;;
  *) echo "unknown leg '$want' (use: core|all|flow|compliance|admission|corridor|tee)"; exit 1 ;;
esac

hr "DONE — open the tx hashes above on https://stellar.expert/explorer/testnet"
