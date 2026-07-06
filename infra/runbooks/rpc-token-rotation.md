# Runbook — rotate an RPC path token

The `/wallet`, `/console`, and `/backend` path tokens are abuse-throttling
identifiers, not secrets (they ship in browser bundles). Rotate one if it is
being abused, or on a schedule. Real access control is on-chain (txAllowList) —
rotating a token does not change who can transact, only which URL the apps use.

## Steps

1. Generate a new token:
   ```sh
   openssl rand -hex 32
   ```
2. Update `infra/vm/.env` on the VM — set `WALLET_RPC_TOKEN` /
   `CONSOLE_RPC_TOKEN` / `BACKEND_RPC_TOKEN`.
3. Reload Caddy (zero-downtime; picks up the new env):
   ```sh
   cd infra/vm && docker compose up -d caddy
   ```
4. Update the consuming app's RPC URL to
   `https://rpc.benzonet.<domain>/<app>/<new-token>`:
   - **wallet / console** — the `VITE_*_RPC_URL` build env, then redeploy the app.
   - **backend** — `BENZONET_RPC_URL`, then restart the API.
5. Verify with `infra/scripts/edge-check.sh` (valid new token → 200; old token → 404).

## Notes

- Rotate one app at a time so the others keep working.
- Because tokens aren't secrets, there is no "leak = emergency" — a hostile
  caller with a token is still bounded by the per-token rate limit and the
  on-chain allowlist. Rotate to cut off sustained abuse, not to "re-secure."
