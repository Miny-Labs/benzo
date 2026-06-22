#!/usr/bin/env bash
# Stage the circuit artifacts into the Docker build context. The prover enclave
# bundles witness-generator WASMs + proving zkeys so a client never ships a zkey
# per proof and the witness is proven inside the attested TEE.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SRC="$REPO/circuits/build"
DST="$HERE/artifacts"

CIRCUITS=(shield joinsplit unshield kyc_credential funds_attestation \
  proof_of_sum_org proof_of_balance_org spending_cap payout_innocence \
  payroll_computation org_spend_auth kyb_credential cross_netting joinsplit_org)

rm -rf "$DST"
mkdir -p "$DST"
for c in "${CIRCUITS[@]}"; do
  mkdir -p "$DST/$c/${c}_js"
  cp "$SRC/$c/${c}.zkey" "$DST/$c/${c}.zkey"
  cp "$SRC/$c/${c}_js/${c}.wasm" "$DST/$c/${c}_js/${c}.wasm"
  printf "  staged %-20s %s\n" "$c" "$(du -h "$DST/$c/${c}.zkey" | cut -f1)"
done
echo "staged $(du -sh "$DST" | cut -f1) -> $DST"
