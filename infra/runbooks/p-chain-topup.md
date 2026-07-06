# Runbook — top up the BenzoNet L1 validator balance

BenzoNet is a sovereign (ACP-77) L1: each validator pays a **continuous fee**
out of a P-Chain balance. When that balance reaches zero the validator is
removed and the L1 stops producing blocks. `pchain-balance-check.sh` alerts
below 1 AVAX (`PChainBalanceLow`); this is how you refill.

## Prerequisites

- `benzo-deployer` P-Chain address funded with Fuji AVAX (this is the standing
  "need from you" — get testnet AVAX from the core.app faucet, coupon
  `avalanche-academy`, or the Builder Hub login faucet).
- The validator's `validationID` (from `avalanche blockchain describe benzonet`
  or the deploy record).

## Steps

1. **Check the current balance:**
   ```sh
   VALIDATION_ID=<id> ./infra/scripts/pchain-balance-check.sh
   ```
2. **Move AVAX C→P** if the P-Chain address is low (avalanche-cli bridges the
   C-Chain export/import):
   ```sh
   avalanche key transfer --fuji \
     --key benzo-deployer --destination-key benzo-deployer \
     --amount 2 --receiver-p-chain
   ```
3. **Increase the validator balance** on the P-Chain:
   ```sh
   avalanche blockchain addValidator benzonet --fuji \
     --increase-balance --validation-id <id> --balance 2
   ```
   (or the P-Chain `platform.increaseL1ValidatorBalance` tx). Balances are
   additive — this extends the runway.
4. **Confirm** the alert clears:
   ```sh
   VALIDATION_ID=<id> ./infra/scripts/pchain-balance-check.sh   # exits 0 when > threshold
   ```

## Sizing

At the Fuji continuous fee, 2 AVAX buys a comfortable multi-week runway for a
single validator — top up to 3–5 AVAX before a demo so it can't drain mid-show.
The cold key is not needed here; `benzo-deployer` funds the balance.
