#!/usr/bin/env bash
# Fetch the EXACT published ZK proving artifacts and verify them against the
# committed manifest (circuits/build/artifacts-manifest.json). Use this to run a
# self-hosted instance that INTEROPERATES with the already-deployed Benzo testnet:
# Groth16 verification keys are setup-specific, so only these exact zkeys produce
# proofs the deployed verifier accepts. (To deploy your OWN contracts from fresh
# keys instead, use scripts/build-artifacts.sh.)
#
# Hosting: set BENZO_ARTIFACTS_BASE_URL to where the artifacts are published. The
# default points at this repo's GitHub Releases 'artifacts' tag; override it for a
# mirror/bucket. Each file is verified by sha256 against the manifest, so a wrong
# or tampered download fails loudly.
#
#   BENZO_ARTIFACTS_BASE_URL=https://.../benzo-artifacts bash scripts/fetch-artifacts.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="circuits/build/artifacts-manifest.json"
[ -f "$MANIFEST" ] || { echo "ERROR: $MANIFEST not found (it is committed; are you at the repo root?)"; exit 1; }

BASE="${BENZO_ARTIFACTS_BASE_URL:-https://github.com/akash-mondal/benzo/releases/download/artifacts}"
echo "Fetching artifacts from: $BASE"
echo "(override with BENZO_ARTIFACTS_BASE_URL=... if you host them elsewhere)"
echo ""

sha256_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }

# Circuits whose proofs are generated in the browser also get staged flat under
# apps/wallet/public/circuits.
is_browser() { case "$1" in joinsplit|proof_of_balance) return 0;; *) return 1;; esac; }

# Enumerate circuits from the manifest (node is always available in this repo).
CIRCUITS=$(node -e "const m=require('./$MANIFEST');console.log(Object.keys(m.circuits).join(' '))")

fetch_verify() { # url, dest, expected_sha
  local url=$1 dest=$2 want=$3
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then echo "  ok (cached) $dest"; return; fi
  echo "  downloading $url"
  curl -fL --retry 3 -o "$dest" "$url"
  local got; got=$(sha256_of "$dest")
  [ "$got" = "$want" ] || { echo "  HASH MISMATCH for $dest: got $got want $want"; exit 1; }
  echo "  verified $dest"
}

for C in $CIRCUITS; do
  echo "== $C =="
  zkeyHash=$(node -e "console.log(require('./$MANIFEST').circuits['$C'].zkeyHash||'')")
  wasmHash=$(node -e "console.log(require('./$MANIFEST').circuits['$C'].wasmHash||'')")
  [ -n "$zkeyHash" ] && fetch_verify "$BASE/$C/$C.zkey" "circuits/build/$C/$C.zkey" "$zkeyHash"
  [ -n "$wasmHash" ] && fetch_verify "$BASE/$C/$C.wasm" "circuits/build/$C/$C.wasm" "$wasmHash"
  if is_browser "$C"; then
    mkdir -p apps/wallet/public/circuits
    cp "circuits/build/$C/$C.zkey" "apps/wallet/public/circuits/$C.zkey"
    cp "circuits/build/$C/$C.wasm" "apps/wallet/public/circuits/$C.wasm"
    echo "  staged browser artifacts -> apps/wallet/public/circuits/"
  fi
done

echo ""
echo "Done. Verified all artifacts against $MANIFEST."
echo "These match the deployed Benzo testnet VKs — a self-hosted client now interoperates with the deployed instance."
