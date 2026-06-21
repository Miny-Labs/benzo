# Benzo — deploy runbook (turnkey)

Two frontends (Vercel) + two BFFs (any container host). Everything below is the
exact sequence; nothing else is required. Testnet is the default — mainnet is the
same steps with the env swapped (see the last section).

```
┌─ Vercel ──────────────┐     ┌─ container host (Fly/Render/…) ─┐     ┌─ Stellar ─┐
│ apps/wallet  (SPA)    │ /api│ apps/wallet-api  (BFF + relay)  │────▶│  Soroban  │
│ apps/console (SPA)    │────▶│ apps/console-api (BFF + relay)  │     │  testnet  │
└───────────────────────┘     └─────────────────────────────────┘     └───────────┘
```

The browser holds the keys, builds the proof, and reads the chain. The BFF is a
stateless gas relay + handle directory (read) + fiat ramp — it submits proven
writes (proof + public inputs, never the witness) and pays gas. Nothing custodial.

---

## 0. One-time prerequisites
- Node 20+, `pnpm` (or corepack), Docker, the `vercel` CLI, and (for the host) the `fly` CLI.
- A funded testnet Stellar key for the operator/relayer (the `DEPLOYER_SECRET`).
- `deployments/testnet.json` is already populated (current contract addresses + the
  re-wired `tee` block). `circuits/build/` holds the proving keys the BFF reads.

## 1. Deploy the two BFFs (do this first — the frontends point at them)

```bash
# Build the images (the Dockerfile installs the stellar CLI + the proving artifacts)
docker build -f Dockerfile.bff --build-arg APP=wallet-api  -t benzo-wallet-api  .
docker build -f Dockerfile.bff --build-arg APP=console-api -t benzo-console-api .

# Example: Fly.io (any host with secrets + a public URL works)
fly launch --no-deploy --name benzo-wallet-api   --dockerfile Dockerfile.bff
fly secrets set DEPLOYER_SECRET=S...  SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
  STELLAR_NETWORK=testnet  WALLET_API_PORT=8791  WALLET_ALLOWED_ORIGIN=https://<your-wallet>.vercel.app
fly deploy --build-arg APP=wallet-api
# repeat for console-api (port 8790, CONSOLE_* env, name benzo-console-api)
```

Note the public origins, e.g. `https://benzo-wallet-api.fly.dev` and
`https://benzo-console-api.fly.dev`.

### BFF env reference
| var | meaning |
|---|---|
| `DEPLOYER_SECRET` | funded testnet Stellar secret (operator/relayer). **Secret — env only.** |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` (or your provider) |
| `STELLAR_NETWORK` | `testnet` (or `mainnet`) |
| `WALLET_API_PORT` / `WALLET_API_PORT=8790` for console | listen port |
| `WALLET_ALLOWED_ORIGIN` | the deployed frontend origin (CORS) |
| `BENZO_DEV_EXPORT` | **leave UNSET in prod** — keys derive from the passkey on-device, never exported |
| `BENZO_KYC_TIER` | optional demo override |

> Per-role hardening (already in code): the relay signs with its own funded key
> (`benzo-relayer`), not the deployer; the relay endpoint is rate-limited + scoped
> to the pool `transfer`/`withdraw` fns only.

## 2. Deploy the two frontends (Vercel)

Each app already ships a `vercel.json` (SPA rewrites + `/api/*` → BFF proxy).

```bash
cd apps/wallet  && vercel --prod      # set Root Directory = apps/wallet in the project
cd ../console   && vercel --prod      # Root Directory = apps/console
```

In each Vercel project's **Settings → Environment Variables**, set the proxy target
used by `vercel.json` (replace the `YOUR-…-API-ORIGIN` placeholder):

- wallet project → point `/api/*` at `https://benzo-wallet-api.fly.dev`
- console project → point `/api/*` at `https://benzo-console-api.fly.dev`

(Either edit `vercel.json`'s `destination` to the real origin, or use a Vercel
rewrite env — the `vercel.json` has the placeholder + a comment.)

Optional client overrides (mainnet / custom RPC) are `VITE_BENZO_*` (see
`apps/wallet/src/lib/network.ts`).

## 3. Smoke-test the deploy
1. Open the wallet URL → sign up (passkey) → Add money → confirm the balance updates.
2. Open `/deposit` → the address + QR render; send testnet USDC → "Ready to import".
3. Send to a @handle → 3-phase ceremony → "Verified on-chain"; tap the tx → "View receipt".
4. Console URL → dashboard loads, "Secure network" badge green.

## 4. Mainnet (same steps, env swap — NOT a code change)
- BFF: `STELLAR_NETWORK=mainnet`, a mainnet `SOROBAN_RPC_URL` (provider), a funded
  mainnet operator key, and `deployments/mainnet.json` (run `BENZO_NETWORK=mainnet
  scripts/deploy-testnet.sh` — it auto-sets `REQUIRE_VK_PROVENANCE=1`).
- Frontend: `VITE_BENZO_NETWORK=mainnet` + `VITE_SOROBAN_RPC_URL` + `VITE_BENZO_DEPLOYMENT`
  (the mainnet deployment JSON).
- Before mainnet: run the multi-party trusted-setup ceremony (`scripts/ceremony.sh`)
  so the proving keys aren't single-author. This is the one step that needs humans.

## What's owner-gated (by design)
Running `vercel --prod`, hosting the BFFs, and any mainnet ceremony require your
accounts + funded keys + (for mainnet) a human ceremony. Those are intentionally
yours to execute — the repo is build- and config-ready for all of them.
