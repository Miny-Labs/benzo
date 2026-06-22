#!/usr/bin/env bash
# Build ALL Benzo ZK proving artifacts from source: compile each Circom circuit,
# run the Groth16 setup, export the verification key, and stage the browser
# artifacts. This is the "compile from source / deploy your own" path — a fresh
# setup produces FRESH (proving key, verification key) PAIRS, so the proofs it
# makes verify against a verifier YOU deploy (scripts/deploy-testnet.sh), not
# against the already-deployed Benzo testnet instance.
#
#   To transact against the ALREADY-DEPLOYED Benzo testnet contracts, use the
#   EXACT published artifacts instead:  scripts/fetch-artifacts.sh
#   (Groth16 VKs are setup-specific; only the exact zkeys match the deployed VKs.)
#
# Requirements: circom 2.2.x and snarkjs on PATH (snarkjs is in node_modules, so
# `pnpm install` first is enough). Phase-1 ptau is the public Hermez powers-of-tau
# (auto-downloaded if missing; ~75MB for 2^16, ~300MB for 2^18).
#
# Usage:
#   bash scripts/build-artifacts.sh            # all circuits
#   bash scripts/build-artifacts.sh shield joinsplit   # a subset
#   CEREMONY=1 bash scripts/build-artifacts.sh # run the phase-2 ceremony for the
#                                              # 3 ceremonied circuits instead of a
#                                              # plain solo setup (see scripts/ceremony.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

# snarkjs ships as a workspace dev dependency; pnpm exec resolves it without a
# global install (it is not hoisted to the root node_modules/.bin). Note: its CLI
# exits non-zero on --version, so we don't precheck it here — the first real
# `groth16 setup` call surfaces a clear error if it's missing (run `pnpm install`).
SNARKJS="pnpm exec snarkjs"
command -v circom >/dev/null 2>&1 || { echo "ERROR: circom not on PATH (need circom 2.2.x). See https://docs.circom.io/getting-started/installation/"; exit 1; }

# circuit -> ptau power. Everything fits 2^16 except joinsplit_org (147k constraints -> 2^18).
PTAU_POW_default=16
declare_pow() { case "$1" in joinsplit_org) echo 18;; *) echo 16;; esac; }

# The 10 circuits the deploy script registers VKs for (deploy-testnet.sh VK loop).
ALL_CIRCUITS=(trivial shield joinsplit unshield proof_of_sum proof_of_sum_org proof_of_balance_org spending_cap payout_innocence payroll_computation kyb_credential cross_netting kyc_credential funds_attestation proof_of_balance org_spend_auth joinsplit_org)
CIRCUITS=("$@"); [ ${#CIRCUITS[@]} -eq 0 ] && CIRCUITS=("${ALL_CIRCUITS[@]}")

# Circuits whose proofs are generated in the BROWSER (staged into apps/wallet/public/circuits).
BROWSER_CIRCUITS=(joinsplit proof_of_balance)
# Circuits with a committed phase-2 ceremony transcript (used when CEREMONY=1).
CEREMONY_CIRCUITS=(joinsplit kyc_credential funds_attestation)

mkdir -p circuits/ptau
ensure_ptau() {
  local pow=$1 f="circuits/ptau/powersOfTau28_hez_final_${pow}.ptau"
  if [ ! -f "$f" ]; then
    echo "==> downloading Hermez ptau 2^${pow} (one-time; large) ..."
    curl -fL --retry 3 -o "$f" "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${pow}.ptau"
  fi
  echo "$f"
}

in_list() { local x=$1; shift; for e in "$@"; do [ "$e" = "$x" ] && return 0; done; return 1; }

for C in "${CIRCUITS[@]}"; do
  src="circuits/groth16/$C.circom"
  [ -f "$src" ] || { echo "skip $C (no $src)"; continue; }
  out="circuits/build/$C"; mkdir -p "$out"
  pow=$(declare_pow "$C"); ptau=$(ensure_ptau "$pow")

  echo "==> [$C] circom compile"
  # All includes are relative (../lib/...), so no -l flags are needed.
  circom "$src" --r1cs --wasm --sym -o "$out"

  if [ "${CEREMONY:-0}" = "1" ] && in_list "$C" "${CEREMONY_CIRCUITS[@]}"; then
    echo "==> [$C] phase-2 multi-contribution ceremony (scripts/ceremony.sh)"
    bash scripts/ceremony.sh "$C"   # writes $out/$C.zkey + ${C}_vk.json
  else
    echo "==> [$C] groth16 setup (solo dev key) over 2^${pow}"
    $SNARKJS groth16 setup "$out/$C.r1cs" "$ptau" "$out/$C.zkey"
    $SNARKJS zkey export verificationkey "$out/$C.zkey" "$out/${C}_vk.json"
  fi

  # Stage a flat wasm next to the zkey (manifest + loaders expect $out/$C.wasm).
  cp "$out/${C}_js/$C.wasm" "$out/$C.wasm"

  if in_list "$C" "${BROWSER_CIRCUITS[@]}"; then
    mkdir -p apps/wallet/public/circuits
    cp "$out/$C.wasm"  "apps/wallet/public/circuits/$C.wasm"
    cp "$out/$C.zkey"  "apps/wallet/public/circuits/$C.zkey"
    echo "==> [$C] staged browser artifacts -> apps/wallet/public/circuits/"
  fi
  echo "==> [$C] done."
done

echo ""
echo "Built: ${CIRCUITS[*]}"
echo "VKs are in circuits/build/<circuit>/<circuit>_vk.json."
echo "NOTE: a fresh solo setup yields FRESH VKs — to use these against the chain you"
echo "must deploy your own verifier (scripts/deploy-testnet.sh), which registers them."
echo "To use the ALREADY-DEPLOYED Benzo testnet, run scripts/fetch-artifacts.sh instead."
