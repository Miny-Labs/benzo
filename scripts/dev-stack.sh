#!/usr/bin/env bash
# Local dev stack for the Benzo console UI phase: the BFF (seeded in-memory store)
# + the console (Vite dev). The console reads the BFF over VITE_API_URL.
#
#   bash scripts/dev-stack.sh
#     console-api -> http://localhost:8790
#     console     -> http://localhost:5174
#
# Going live on testnet (wire @benzo/core in apps/console-api/src/chain.ts):
#   set -a; . ./.env; set +a
#   then also start: the anchor (packages/anchor), relayer (packages/relayer),
#   and indexer (packages/indexer) — see docs/FRONTEND-AND-TESTS.md.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> building shared packages (types, connectors) + BFF"
pnpm --filter @benzo/types --filter @benzo/connectors --filter @benzo/console-api build

API_PORT="${CONSOLE_API_PORT:-8790}"
WEB_PORT="${CONSOLE_WEB_PORT:-5174}"

echo "==> starting console-api on :$API_PORT"
( CONSOLE_API_PORT="$API_PORT" node apps/console-api/dist/server.js ) &
API_PID=$!

echo "==> starting console (Vite) on :$WEB_PORT"
( cd apps/console && VITE_API_URL="http://localhost:$API_PORT" pnpm exec vite --port "$WEB_PORT" ) &
WEB_PID=$!

trap 'kill "$API_PID" "$WEB_PID" 2>/dev/null || true' EXIT
echo "==> console-api :$API_PORT  ·  console :$WEB_PORT   (Ctrl-C to stop)"
wait
