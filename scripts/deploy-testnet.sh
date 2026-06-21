#!/usr/bin/env bash
# Deploy the full Benzo stack to Stellar and wire it together.
# Usage (testnet, default):  set -a; . ./.env; set +a; bash scripts/deploy-testnet.sh
# Usage (mainnet):           set -a; . ./.env.mainnet; set +a; BENZO_NETWORK=mainnet bash scripts/deploy-testnet.sh
# Network-agnostic: BENZO_NETWORK (testnet|mainnet, default testnet) selects the
# --network, the deployments/<net>.json output, and the explorer URL. Mainnet
# additionally REQUIRES a finalized multi-party ceremony (set REQUIRE_VK_PROVENANCE=1)
# and a funded deployer + per-app operator keys.
set -euo pipefail

cd "$(dirname "$0")/.."
NETWORK="${BENZO_NETWORK:-testnet}"
[ "$NETWORK" = "testnet" ] || [ "$NETWORK" = "mainnet" ] || { echo "BENZO_NETWORK must be testnet|mainnet"; exit 1; }
export STELLAR_NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:?load .env first}"
SOURCE=benzo-deployer
ADMIN="$DEPLOYER_PUBLIC"
NET=(--network "$NETWORK")
EXPLORER="https://stellar.expert/explorer/$NETWORK"
DEPLOY_OUT="deployments/${NETWORK}.json"
# Mainnet must not deploy un-provenanced (single-author) VKs.
[ "$NETWORK" = "mainnet" ] && export REQUIRE_VK_PROVENANCE="${REQUIRE_VK_PROVENANCE:-1}"
W=target/wasm32v1-none/release

TREE_LEVELS=32
ASP_LEVELS=16
MVK_LEVELS=16             # must equal the circuits' mvkLevels (shield/joinsplit/unshield)
MAX_DEPOSIT=10000000000   # 1,000 USDC (7dp)

say() { echo "==> $*" >&2; }
sha256_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }

deploy() { # wasm, then constructor args...
  local wasm=$1; shift
  stellar contract deploy --wasm "$W/$wasm" --source $SOURCE "${NET[@]}" -- "$@" 2>/dev/null | tail -1
}

if [ "${USE_TEST_TOKEN:-false}" = "true" ]; then
  say "USE_TEST_TOKEN=true is set, but deployer holds real testnet USDC; aborting to avoid ambiguity"
  exit 1
fi

# BN254 (CAP-0074) + Poseidon2 (CAP-0075) host functions require protocol >= 25.
# Fail early against an older self-host quickstart image rather than trapping
# opaquely on the first on-chain verify.
say "checking network protocol (need >= 25 for BN254/Poseidon2)"
PROTO=$(curl -s "${SOROBAN_RPC_URL:-}" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}' 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.protocolVersion??0)}catch{console.log(0)}})' 2>/dev/null) || PROTO=0
if [ "${PROTO:-0}" -ge 25 ] 2>/dev/null; then
  say "  protocol $PROTO OK"
elif [ "${PROTO:-0}" -gt 0 ] 2>/dev/null; then
  say "ERROR: network protocol $PROTO < 25 — BN254/Poseidon2 host functions unavailable. Use a protocol-25+ network."
  exit 1
else
  say "  WARNING: could not determine protocol version (is SOROBAN_RPC_URL set and reachable?) — proceeding"
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

say "deploying mvk_registry (levels=$MVK_LEVELS; authorized-MVK set, audit P0 B.4)"
MVKREG=$(deploy benzo_mvk_registry.wasm --admin "$ADMIN" --levels $MVK_LEVELS)
say "mvk_registry: $MVKREG"

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

say "wiring mvk_registry into the pool (registeredMvkRoot enforcement)"
stellar contract invoke --id "$POOL" --source $SOURCE "${NET[@]}" -- set_mvk_registry --registry "$MVKREG" >/dev/null

say "deploying handle_registry (@handle directory; permissionless, no constructor)"
HANDLEREG=$(deploy benzo_handle_registry.wasm)
say "handle_registry: $HANDLEREG"

say "deploying request_registry (pull primitive; reads nullifier_set for paid-proof)"
REQREG=$(deploy benzo_request_registry.wasm --admin "$ADMIN" --nullifier_set "$NULLS")
say "request_registry: $REQREG"

say "deploying org_account (dual-control org primitive; consumer = org-of-one)"
ORGACCT=$(deploy benzo_org_account.wasm --admin "$ADMIN")
say "org_account: $ORGACCT"

# Designate the on-chain KYB issuer — the key allowed to post KYB attestations
# (issuer-gated in org_account). This is the integration seam: ADMIN today; a real
# KYB provider (Persona/Sumsub) would hold this key, or we re-point to theirs.
KYB_ISSUER="${KYB_ISSUER:-$ADMIN}"
say "designating org_account KYB issuer: $KYB_ISSUER"
stellar contract invoke --id "$ORGACCT" --source $SOURCE "${NET[@]}" -- \
  set_kyb_issuer --issuer "$KYB_ISSUER" >/dev/null
say "  KYB issuer set (on-chain KYB attestations enabled)"

say "deploying ramp (on/off-ramp USDC reserve; the on-chain analog of a MoneyGram/SEP-24 anchor distribution account)"
RAMP=$(deploy benzo_ramp.wasm --admin "$ADMIN" --usdc "$TOKEN")
say "ramp: $RAMP"
# Optionally seed the reserve so add-money can dispense immediately. Uses REAL
# USDC from the deployer — gated behind RAMP_FUND_STROOPS (unset → skip, no funds
# move). e.g. RAMP_FUND_STROOPS=50000000 funds 5 USDC.
if [ -n "${RAMP_FUND_STROOPS:-}" ]; then
  say "funding ramp reserve with $RAMP_FUND_STROOPS stroops USDC from deployer"
  stellar contract invoke --id "$RAMP" --source $SOURCE "${NET[@]}" -- \
    fund --from "$ADMIN" --amount "$RAMP_FUND_STROOPS" >/dev/null
  say "  ramp reserve funded"
else
  say "  (RAMP_FUND_STROOPS unset — ramp deployed empty; fund it before first add-money)"
fi

say "deploying identity_nullifier_set (KYC sybil resistance)"
IDNULLS=$(deploy benzo_identity_nullifier_set.wasm --admin "$ADMIN")
say "identity_nullifier_set: $IDNULLS"

say "deploying issuer_registry (authorized-issuer set for ZK-KYC admission)"
ISSUERREG=$(deploy benzo_issuer_registry.wasm --admin "$ADMIN" --levels $MVK_LEVELS)
say "issuer_registry: $ISSUERREG"

say "registering verification keys"
# NOTE: `trivial` (a pipeline de-risk circuit that proves nothing) is intentionally
# NOT deployed — it inflates the on-chain VK surface and its degenerate setup can
# violate the verifier's gamma!=delta anti-malleability check. The 9 VKs below are
# the real ones (4 settle-gate + 5 attestations).
for c in shield:SHIELD joinsplit:TRANSFER unshield:UNSHIELD proof_of_sum:SUM kyc_credential:KYC funds_attestation:FUNDS proof_of_balance:BALANCE org_spend_auth:ORGAUTH joinsplit_org:JSPLITORG; do
  name=${c%%:*}; id=${c##*:}
  build_vk="circuits/build/$name/${name}_vk.json"
  cer_vk="ceremony/$name/${name}_vk.json"
  # VK provenance (P0-2): if a phase-2 ceremony transcript exists for this
  # circuit, the VK we are about to deploy MUST byte-match the ceremony's
  # finalized VK — else the deployed key has no traceable provenance to the
  # committed transcript and a reviewer cannot reproduce it. Abort on drift.
  if [ -f "$cer_vk" ]; then
    bh=$(sha256_of "$build_vk"); ch=$(sha256_of "$cer_vk")
    if [ "$bh" = "$ch" ]; then
      say "  VK provenance OK ($name): sha256=$bh matches ceremony/$name"
    elif [ "${REQUIRE_VK_PROVENANCE:-0}" = "1" ]; then
      say "ERROR: $name VK provenance broken — build sha256=$bh != ceremony sha256=$ch"
      say "  Re-run scripts/ceremony.sh $name (it now wires final.zkey + VK into circuits/build/$name),"
      say "  regenerate the proving fixtures, and commit the byte-matched pair. Aborting (REQUIRE_VK_PROVENANCE=1)."
      exit 1
    else
      say "  WARNING ($name): build VK != ceremony VK (build=$bh ceremony=$ch) — deploying the live BUILD key,"
      say "    which has NO provenance to the committed ceremony transcript. Run ceremony.sh $name to reconcile,"
      say "    or set REQUIRE_VK_PROVENANCE=1 to make this a hard failure."
    fi
  else
    say "  WARNING: no ceremony VK for $name ($cer_vk) — deployed VK has NO multi-party provenance (gap E1)"
  fi
  vkjson=$(node scripts/groth16-to-soroban.mjs vk "$build_vk")
  vktx=$(stellar contract invoke --id "$VERIFIER" --source $SOURCE "${NET[@]}" -- set_vk --vk_id "$id" --vk "$vkjson" 2>&1 | grep -oE 'Signing transaction: [0-9a-f]{64}' | grep -oE '[0-9a-f]{64}')
  say "set_vk $id  tx $vktx"
  say "  $EXPLORER/tx/$vktx"
done

say "wiring KYC proof-gated admission into asp_membership (verifier + KYC vk)"
stellar contract invoke --id "$ASPM" --source $SOURCE "${NET[@]}" -- \
  set_kyc_verifier --verifier "$VERIFIER" --vk_id KYC >/dev/null

say "wiring issuer_registry + min-tier into asp_membership (only registered issuers, risk-based tier)"
stellar contract invoke --id "$ASPM" --source $SOURCE "${NET[@]}" -- \
  set_issuer_registry --registry "$ISSUERREG" >/dev/null
stellar contract invoke --id "$ASPM" --source $SOURCE "${NET[@]}" -- \
  set_min_tier --min_tier "${ASP_MIN_TIER:-1}" >/dev/null
say "  asp min_tier=${ASP_MIN_TIER:-1}; issuer_registry wired"

# Optional: seed the authorized-MVK registry with the operator's MVK so the
# first shields verify. Set MVK_PUB (decimal field element) and optionally
# MVK_KEY_META in .env; skipped otherwise (the registry can be populated later).
if [ -n "${MVK_PUB:-}" ]; then
  say "registering operator MVK in mvk_registry (mvk_pub=$MVK_PUB)"
  stellar contract invoke --id "$MVKREG" --source $SOURCE "${NET[@]}" -- \
    register_mvk --mvk_pub "$MVK_PUB" --key_meta "${MVK_KEY_META:-0}" >/dev/null
else
  say "  (MVK_PUB unset — skipping operator-MVK seeding; populate mvk_registry before first shield)"
fi

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
cat > "$DEPLOY_OUT" <<EOF
{
  "network": "$NETWORK",
  "admin": "$ADMIN",
  "token": "$TOKEN",
  "usdcAsset": "$USDC_CODE:$USDC_ISSUER",
  "verifier": "$VERIFIER",
  "registeredVks": ["SHIELD", "TRANSFER", "UNSHIELD", "SUM", "KYC", "FUNDS", "BALANCE", "ORGAUTH", "JSPLITORG"],
  "merkle": "$MERKLE",
  "nullifierSet": "$NULLS",
  "aspMembership": "$ASPM",
  "aspNonMembership": "$ASPN",
  "viewkeyAnchor": "$VKA",
  "mvkRegistry": "$MVKREG",
  "issuerRegistry": "$ISSUERREG",
  "pool": "$POOL",
  "ramp": "$RAMP",
  "handleRegistry": "$HANDLEREG",
  "requestRegistry": "$REQREG",
  "orgAccount": "$ORGACCT",
  "kybIssuer": "$KYB_ISSUER",
  "identityNullifierSet": "$IDNULLS",
  "treeLevels": $TREE_LEVELS,
  "aspLevels": $ASP_LEVELS,
  "mvkLevels": $MVK_LEVELS,
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
      "mvkRegistry": "$(wasmhash benzo_mvk_registry.wasm)",
      "issuerRegistry": "$(wasmhash benzo_issuer_registry.wasm)",
      "pool": "$(wasmhash benzo_pool.wasm)",
      "ramp": "$(wasmhash benzo_ramp.wasm)",
      "handleRegistry": "$(wasmhash benzo_handle_registry.wasm)",
      "requestRegistry": "$(wasmhash benzo_request_registry.wasm)",
      "orgAccount": "$(wasmhash benzo_org_account.wasm)",
      "identityNullifierSet": "$(wasmhash benzo_identity_nullifier_set.wasm)"
    }
  }
}
EOF
say "wrote $DEPLOY_OUT"
cat "$DEPLOY_OUT"
