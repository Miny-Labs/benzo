#!/usr/bin/env bash
# Pre-demo go/no-go for the BenzoNet stack. Checks the public edge (TLS), the
# chain (advancing blocks, correct chainId), the validator, and the P-Chain
# fee balance. Sources infra/vm/.env. Run from outside the VM.
#
#   ./infra/scripts/healthcheck.sh
#
# Env (optional): VALIDATOR_HEALTH_URL, VALIDATION_ID (for the P-Chain check).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/../vm/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi
: "${RPC_DOMAIN:?set RPC_DOMAIN}"
: "${BACKEND_RPC_TOKEN:?set BACKEND_RPC_TOKEN}"
# BLOCKCHAIN_ID isn't needed here — Caddy rewrites the /backend token path to
# /ext/bc/<id>/rpc, so this script never references the id directly.

RPC="https://${RPC_DOMAIN}/backend/${BACKEND_RPC_TOKEN}"
EXPECTED_CHAINID="0x10b04" # 68420
fails=0
pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; fails=$((fails + 1)); }

rpc_call() {
  curl -s -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}

echo "1) Caddy TLS + edge reachable"
if curl -sI --max-time 10 "https://${RPC_DOMAIN}" >/dev/null 2>&1; then
  pass "TLS handshake ok"
else
  fail "TLS/edge unreachable"
fi

echo "2) chainId == 68420"
cid="$(rpc_call eth_chainId | jq -r '.result // empty')"
[[ "$cid" == "$EXPECTED_CHAINID" ]] && pass "chainId $cid" || fail "expected $EXPECTED_CHAINID, got '$cid'"

echo "3) block height advancing"
h1="$(rpc_call eth_blockNumber | jq -r '.result // "0x0"')"
sleep 5
h2="$(rpc_call eth_blockNumber | jq -r '.result // "0x0"')"
if [[ "$h1" != "0x0" && $((h2)) -gt $((h1)) ]]; then
  pass "height $((h1)) -> $((h2))"
else
  fail "height not advancing ($h1 -> $h2)"
fi

echo "4) validator health"
if [[ -n "${VALIDATOR_HEALTH_URL:-}" ]]; then
  if curl -sf --max-time 10 "$VALIDATOR_HEALTH_URL" | jq -e '.healthy == true' >/dev/null 2>&1; then
    pass "validator healthy"
  else
    fail "validator unhealthy/unreachable"
  fi
else
  echo "  (skipped: set VALIDATOR_HEALTH_URL)"
fi

echo "5) P-Chain validator fee balance"
if [[ -n "${VALIDATION_ID:-}" ]]; then
  # 0 = ok, 1 = below threshold, 2 = API error/no balance — report distinctly.
  "$HERE/pchain-balance-check.sh"; rc=$?
  case "$rc" in
    0) pass "balance above threshold" ;;
    1) fail "balance below threshold (top up)" ;;
    *) fail "P-Chain balance check errored (rc=$rc) — could not read balance" ;;
  esac
else
  echo "  (skipped: set VALIDATION_ID)"
fi

echo
if [[ "$fails" -eq 0 ]]; then
  echo "healthcheck: GO."
else
  echo "healthcheck: NO-GO — $fails check(s) failed."
  exit 1
fi
