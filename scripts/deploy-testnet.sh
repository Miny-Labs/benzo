#!/usr/bin/env bash
# Deploy the full Benzo stack to Stellar testnet and wire it together.
# Usage: set -a; . ./.env; set +a; bash scripts/deploy-testnet.sh
# Writes deployments/testnet.json and prints every contract id + tx.
set -euo pipefail

cd "$(dirname "$0")/.."
export STELLAR_NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:?load .env first}"
SOURCE=benzo-deployer
ADMIN="$DEPLOYER_PUBLIC"
NET=(--network testnet)
W=target/wasm32v1-none/release

TREE_LEVELS=32
ASP_LEVELS=16
MAX_DEPOSIT=10000000000   # 1,000 USDC (7dp)

say() { echo "==> $*" >&2; }

deploy() { # wasm, then constructor args...
  local wasm=$1; shift
  stellar contract deploy --wasm "$W/$wasm" --source $SOURCE "${NET[@]}" -- "$@" 2>/dev/null | tail -1
}

if [ "${USE_TEST_TOKEN:-false}" = "true" ]; then
  say "USE_TEST_TOKEN=true is set, but deployer holds real testnet USDC; aborting to avoid ambiguity"
  exit 1
fi

say "resolving USDC SAC contract id"
TOKEN=$(stellar contract id asset --asset "$USDC_CODE:$USDC_ISSUER" "${NET[@]}")
say "USDC SAC: $TOKEN"

say "deploying merkle (levels=$TREE_LEVELS)"
MERKLE=$(deploy benzo_merkle.wasm --admin "$ADMIN" --levels $TREE_LEVELS)
say "merkle: $MERKLE"

say "deploying nullifier_set"
NULLS=$(deploy benzo_nullifier_set.wasm --admin "$ADMIN")
say "nullifier_set: $NULLS"

say "deploying asp_membership (levels=$ASP_LEVELS)"
ASPM=$(deploy asp_membership.wasm --admin "$ADMIN" --levels $ASP_LEVELS)
say "asp_membership: $ASPM"

say "deploying asp_non_membership"
ASPN=$(deploy asp_non_membership.wasm --admin "$ADMIN")
say "asp_non_membership: $ASPN"

say "deploying viewkey_anchor"
VKA=$(deploy benzo_viewkey_anchor.wasm --admin "$ADMIN")
say "viewkey_anchor: $VKA"

VERIFIER=${VERIFIER_OVERRIDE:-}
if [ -z "$VERIFIER" ]; then
  say "deploying verifier"
  VERIFIER=$(deploy benzo_verifier_groth16.wasm --admin "$ADMIN")
fi
say "verifier: $VERIFIER"

say "deploying pool"
POOL=$(deploy benzo_pool.wasm \
  --admin "$ADMIN" --token "$TOKEN" --verifier "$VERIFIER" \
  --merkle "$MERKLE" --nullifier_set "$NULLS" \
  --asp_membership "$ASPM" --asp_non_membership "$ASPN" \
  --viewkey_anchor "$VKA" --maximum_deposit_amount $MAX_DEPOSIT)
say "pool: $POOL"

say "wiring operators to the pool"
for c in $MERKLE $NULLS $VKA; do
  stellar contract invoke --id "$c" --source $SOURCE "${NET[@]}" -- set_operator --operator "$POOL" >/dev/null
done

say "deploying handle_registry (@handle directory; permissionless, no constructor)"
HANDLEREG=$(deploy benzo_handle_registry.wasm)
say "handle_registry: $HANDLEREG"

say "deploying request_registry (pull primitive; reads nullifier_set for paid-proof)"
REQREG=$(deploy benzo_request_registry.wasm --admin "$ADMIN" --nullifier_set "$NULLS")
say "request_registry: $REQREG"

say "registering verification keys"
for c in shield:SHIELD joinsplit:TRANSFER unshield:UNSHIELD; do
  name=${c%%:*}; id=${c##*:}
  vkjson=$(node scripts/groth16-to-soroban.mjs vk "circuits/build/$name/${name}_vk.json")
  vktx=$(stellar contract invoke --id "$VERIFIER" --source $SOURCE "${NET[@]}" -- set_vk --vk_id "$id" --vk "$vkjson" 2>&1 | grep -oE 'Signing transaction: [0-9a-f]{64}' | grep -oE '[0-9a-f]{64}')
  say "set_vk $id  tx $vktx"
  say "  https://stellar.expert/explorer/testnet/tx/$vktx"
done

# One-time: the relayer needs a USDC trustline to receive its USDC fee.
# (Idempotent — skips if the trustline already exists.)
say "ensuring relayer USDC trustline"
stellar tx new change-trust --source benzo-relayer "${NET[@]}" \
  --line "$USDC_CODE:$USDC_ISSUER" 2>/dev/null || say "  (relayer trustline already present)"

# Provenance: pin the source commit, deploy time, and the sha256 of each
# deployed wasm so the on-chain bytecode is reproducibly verifiable.
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
wasmhash() { shasum -a 256 "$W/$1" 2>/dev/null | awk '{print $1}' || sha256sum "$W/$1" | awk '{print $1}'; }

mkdir -p deployments
cat > deployments/testnet.json <<EOF
{
  "network": "testnet",
  "admin": "$ADMIN",
  "token": "$TOKEN",
  "usdcAsset": "$USDC_CODE:$USDC_ISSUER",
  "verifier": "$VERIFIER",
  "merkle": "$MERKLE",
  "nullifierSet": "$NULLS",
  "aspMembership": "$ASPM",
  "aspNonMembership": "$ASPN",
  "viewkeyAnchor": "$VKA",
  "pool": "$POOL",
  "handleRegistry": "$HANDLEREG",
  "requestRegistry": "$REQREG",
  "treeLevels": $TREE_LEVELS,
  "aspLevels": $ASP_LEVELS,
  "smtLevels": 16,
  "provenance": {
    "commit": "$COMMIT",
    "deployedAt": "$DEPLOYED_AT",
    "wasmSha256": {
      "verifier": "$(wasmhash benzo_verifier_groth16.wasm)",
      "merkle": "$(wasmhash benzo_merkle.wasm)",
      "nullifierSet": "$(wasmhash benzo_nullifier_set.wasm)",
      "aspMembership": "$(wasmhash asp_membership.wasm)",
      "aspNonMembership": "$(wasmhash asp_non_membership.wasm)",
      "viewkeyAnchor": "$(wasmhash benzo_viewkey_anchor.wasm)",
      "pool": "$(wasmhash benzo_pool.wasm)",
      "handleRegistry": "$(wasmhash benzo_handle_registry.wasm)",
      "requestRegistry": "$(wasmhash benzo_request_registry.wasm)"
    }
  }
}
EOF
say "wrote deployments/testnet.json"
cat deployments/testnet.json
