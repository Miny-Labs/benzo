#!/usr/bin/env bash
# Edge smoke test for the BenzoNet Caddy front. Run against the LIVE deployment
# from a machine OUTSIDE the VM. Sources infra/vm/.env for tokens/domain/origins
# (or take them from the environment).
#
#   ./infra/scripts/edge-check.sh
#
# Exits non-zero if any of the five cases fails.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/../vm/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi

: "${RPC_DOMAIN:?set RPC_DOMAIN}"
: "${WALLET_RPC_TOKEN:?set WALLET_RPC_TOKEN}"
: "${WALLET_ORIGIN:?set WALLET_ORIGIN}"
: "${BLOCKCHAIN_ID:?set BLOCKCHAIN_ID}"

BASE="https://${RPC_DOMAIN}"
BODY='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
fails=0

pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; fails=$((fails + 1)); }

# curl helper: prints the HTTP status code for a POST.
status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' "$@" --data "$BODY" || echo "000"
}

echo "1) valid wallet token + origin -> 200 with a chainId result"
resp="$(curl -s -X POST -H 'Content-Type: application/json' \
  -H "Origin: ${WALLET_ORIGIN}" --data "$BODY" \
  "${BASE}/wallet/${WALLET_RPC_TOKEN}" || true)"
if grep -q '"result"' <<<"$resp"; then pass "chainId returned"; else fail "no result: $resp"; fi

echo "2) wrong token -> 404"
code="$(status -H "Origin: ${WALLET_ORIGIN}" "${BASE}/wallet/deadbeef")"
[[ "$code" == "404" ]] && pass "wrong token 404" || fail "expected 404, got $code"

echo "3) wallet token with disallowed origin -> 403 (no CORS)"
code="$(status -H "Origin: https://evil.example.com" "${BASE}/wallet/${WALLET_RPC_TOKEN}")"
[[ "$code" == "403" ]] && pass "bad origin 403" || fail "expected 403, got $code"

echo "4) direct /ext path, no token -> 404"
code="$(status -H "Origin: ${WALLET_ORIGIN}" "${BASE}/ext/bc/${BLOCKCHAIN_ID}/rpc")"
[[ "$code" == "404" ]] && pass "bare /ext 404" || fail "expected 404, got $code"

echo "5) node ports 9650 (HTTP) + 9651 (staking) not reachable from the internet"
if command -v nc >/dev/null 2>&1; then
  for port in 9650 9651; do
    if nc -z -w 5 "$RPC_DOMAIN" "$port" 2>/dev/null; then
      fail "port $port is OPEN to the internet"
    else
      pass "port $port refused/filtered"
    fi
  done
else
  echo "  (skipped: nc not installed)"
fi

echo
if [[ "$fails" -eq 0 ]]; then
  echo "edge-check: all cases passed."
else
  echo "edge-check: $fails case(s) FAILED."
  exit 1
fi
