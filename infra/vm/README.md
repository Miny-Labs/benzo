# BenzoNet VM — RPC node + public edge

Production shape: the **validator** runs on its own host with its APIs private;
a separate **dedicated RPC node** tracks the subnet and is the only thing the
reverse proxy talks to. The subnet is `validatorOnly`, so random nodes cannot
sync it — the RPC node is explicitly allowlisted. **Caddy** terminates TLS and
is the single public entry.

```
internet ──▶ Caddy (:443)  ──▶ rpc-node:9650  ──(tracks subnet)──▶ validator (private)
             per-app token         (no host ports)
```

This directory is the RPC + edge box's `docker compose` stack. The validator is
provisioned separately (it only needs the subnet config + the same subnet-evm
plugin); see [Validator](#validator).

## Contents

| Path | What |
|------|------|
| `docker-compose.yml` | `rpc-node`, `caddy`; `prometheus`/`grafana` gated behind the `monitoring` profile (configured in #28) |
| `caddy/Dockerfile` | Custom Caddy (xcaddy + `caddy-ratelimit`) |
| `caddy/Caddyfile` | TLS, per-app path tokens, CORS allowlist, per-token rate limits |
| `configs/subnets/SUBNET_ID.json` | `validatorOnly` + `allowedNodes` — **rename to `<subnetID>.json`** |
| `configs/chains/<blockchainID>/config.json` | RPC-node chain config (eth query APIs on) |
| `configs/validator-chain-config.json` | Validator variant (no eth/admin APIs) — deploy on the validator |
| `plugins/` | Operator-installed subnet-evm VM binary (gitignored) |
| `.env.example` | Copy to `.env`; fill tokens/domain/origins |

## Bring-up order

1. **DNS** — point an A record `rpc.benzonet.<domain>` at this VM's public IP.
   Caddy uses Let's Encrypt HTTP-01, so the name must resolve before first boot.
2. **Env** — `cp .env.example .env` and fill it in. Generate each token with
   `openssl rand -hex 32`. Set `SUBNET_ID` from `avalanche blockchain describe
   benzonet`.
3. **Subnet config** — rename `configs/subnets/SUBNET_ID.json` to
   `configs/subnets/<subnetID>.json` and set `allowedNodes` to the rpc-node's
   `NodeID-…` (read it after first boot from `/ext/info` `getNodeID`, then
   restart). Deploy the **same** subnet file to the validator.
4. **VM plugin** — install the subnet-evm binary keyed by the VM ID from
   `avalanche blockchain describe benzonet` at:
   ```
   infra/vm/plugins/<vmID>
   ```
   (chmod +x; the exact `<vmID>` is the "VM ID" line in `describe`.)
5. **Boot** — `docker compose up -d`. The rpc-node does a `--partial-sync-primary-network`
   P-Chain bootstrap (minutes, not the multi-hour full C/X sync), then starts
   tracking BenzoNet.

## Verify

```sh
# health (from inside the docker network / on the VM):
docker compose exec rpc-node curl -fs http://localhost:9650/ext/health | jq .healthy
# chain answers:
docker compose exec rpc-node curl -fs -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  "http://localhost:9650/ext/bc/${BLOCKCHAIN_ID}/rpc"
# public edge (from OUTSIDE the VM):
./infra/scripts/edge-check.sh
```

Expect `healthy: true` for the BenzoNet chain and an advancing `eth_blockNumber`.
No node port (9650/9651) is published to the host — only Caddy binds 80/443.

## Negative test (proves `validatorOnly`)

Start a scratch avalanchego node that tracks the subnet but is **not** in
`allowedNodes`; it must fail to sync BenzoNet. Record the result here:

> _Operator to record: scratch NodeID-… attempted sync on <date> → rejected
> (not in allowedNodes). ✅ validatorOnly enforced._

## Disk sizing

- `--partial-sync-primary-network` keeps the P-Chain only, so primary-network
  disk is small (a few GB). BenzoNet's own DB grows with usage.
- Start with **≥ 100 GB SSD** on the RPC node (`pruning-enabled: false` keeps
  full state for the explorer in #29); the validator can prune
  (`pruning-enabled: true`) and run smaller.
- Monitor disk in the monitoring stack (alert at 80%).

## Monitoring

Opt-in profile (Prometheus + node-exporter + Grafana):

```sh
cd infra/vm && docker compose --profile monitoring up -d
```

- **Prometheus** (`prometheus/prometheus.yml`) scrapes the rpc-node and
  validator `/ext/metrics` and node-exporter every 15s; alert rules live in
  `prometheus/alerts.yml`.
- **Grafana** is provisioned with the Prometheus datasource and the *BenzoNet
  Overview* dashboard (`grafana/dashboards/`); import the richer ava-labs
  [avalanche-monitoring](https://github.com/ava-labs/avalanche-monitoring)
  dashboards for full node internals. Grafana is served through Caddy at
  `{$GRAFANA_DOMAIN}` behind `basic_auth` — generate the hash with
  `caddy hash-password` and set `GRAFANA_*` in `.env` (+ a DNS A-record).
- **Alerts**: rpc-node/validator down (>2m), chain height stalled (>5m), disk
  >80%, and the P-Chain fee balance <1 AVAX. Verify the chain-height metric
  name in `alerts.yml` against the live `/ext/metrics` — avalanchego metric
  names are version-specific.
- **P-Chain balance**: cron `infra/scripts/pchain-balance-check.sh` (needs
  `VALIDATION_ID`) writes a node-exporter textfile metric and alerts below
  threshold → `infra/runbooks/p-chain-topup.md`.
- **Go/no-go**: `infra/scripts/healthcheck.sh` checks TLS, chainId, advancing
  blocks, validator health, and P-Chain balance in one shot before a demo.

## Validator

The validator host runs the same avalanchego + subnet-evm plugin, tracks the
subnet, and gets:
- `configs/subnets/<subnetID>.json` — identical `validatorOnly` + `allowedNodes`
  file (so it accepts the rpc-node as a sync peer).
- `configs/chains/<blockchainID>/config.json` — the `validator-chain-config.json`
  variant (no eth query APIs, no admin API).
- **No published ports.** Its APIs never leave its host; all reads go to the
  rpc-node.
