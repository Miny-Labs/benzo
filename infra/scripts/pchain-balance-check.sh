#!/usr/bin/env bash
# P-Chain continuous-validator fee-balance watcher for the BenzoNet L1.
#
# A PoA L1's validator pays a continuous fee out of a P-Chain balance; when it
# hits zero, validation stops. This queries the balance, writes it as a
# Prometheus textfile metric (scraped by node-exporter), and exits non-zero
# below the threshold so it can also gate cron/alerting.
#
# Run via cron on the VM, e.g. every 5 min:
#   */5 * * * * VALIDATION_ID=… /path/infra/scripts/pchain-balance-check.sh
#
# Env:
#   VALIDATION_ID  (required) the L1 validator's validationID
#   PCHAIN_RPC     P-Chain API (default: public Fuji)
#   TEXTFILE_DIR   node-exporter textfile dir (default: infra/vm/prometheus/textfile)
#   THRESHOLD_AVAX alert threshold (default: 1)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${VALIDATION_ID:?set VALIDATION_ID (the L1 validator validationID)}"
PCHAIN_RPC="${PCHAIN_RPC:-https://api.avax-test.network/ext/bc/P}"
TEXTFILE_DIR="${TEXTFILE_DIR:-$HERE/../vm/prometheus/textfile}"
THRESHOLD_AVAX="${THRESHOLD_AVAX:-1}"

resp="$(curl -s --connect-timeout 5 --max-time 15 -X POST -H 'content-type: application/json' --data "$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"platform.getL1Validator","params":{"validationID":"$VALIDATION_ID"}}
JSON
)" "$PCHAIN_RPC")" || { echo "P-Chain request failed/timed out ($PCHAIN_RPC)" >&2; exit 2; }

# balance is nAVAX (1e9 nAVAX = 1 AVAX). jq keeps integer precision.
balance_navax="$(echo "$resp" | jq -r '.result.balance // empty')"
if [[ -z "$balance_navax" ]]; then
  echo "could not read balance from P-Chain: $resp" >&2
  exit 2
fi
balance_avax="$(awk -v n="$balance_navax" 'BEGIN { printf "%.4f", n / 1000000000 }')"

mkdir -p "$TEXTFILE_DIR"
tmp="$(mktemp "$TEXTFILE_DIR/pchain.prom.XXXX")"
{
  echo "# HELP benzonet_pchain_validator_balance_avax L1 validator P-Chain fee balance."
  echo "# TYPE benzonet_pchain_validator_balance_avax gauge"
  echo "benzonet_pchain_validator_balance_avax $balance_avax"
} >"$tmp"
mv "$tmp" "$TEXTFILE_DIR/pchain-balance.prom"  # atomic swap for node-exporter

echo "P-Chain validator balance: $balance_avax AVAX (threshold $THRESHOLD_AVAX)"
if awk -v b="$balance_avax" -v t="$THRESHOLD_AVAX" 'BEGIN { exit !(b < t) }'; then
  echo "BELOW THRESHOLD — top up (infra/runbooks/p-chain-topup.md)" >&2
  exit 1
fi
