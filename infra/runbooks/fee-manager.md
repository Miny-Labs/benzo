# Runbook — BenzoNet fee manager

BenzoNet's dynamic-fee parameters are set in genesis and can be retuned at
runtime through the **Fee Manager precompile**
`0x0200000000000000000000000000000000000003` (`IFeeManager`, vendored in
`contracts/contracts/precompiles/`). The live config is read with
`getFeeConfig()` and surfaced in chain-health (see
`infra/scripts/healthcheck.sh` and the monitoring stack) and on the console
Network surface — so you rarely need this runbook, but here it is.

## Who can change it

`feeManager.admin = [benzo-admin-cold]`, `manager = []`, `enabled = []`
(genesis). **Only the cold admin key may change fees**, and it is the only role
that can. This is deliberate: fee policy is a rare, high-trust action, so it
stays off any hot/backend key. To let an ops key make a one-off change, the cold
key `setManager`s it, the change is made, then `setNone` revokes it.

## Current config (genesis)

| Field | Value | Note |
|-------|-------|------|
| `gasLimit` | 20_000_000 | per-block gas ceiling |
| `targetBlockRate` | 2 | seconds/block |
| `minBaseFee` | 1_000_000_000 | 1 gwei — the floor |
| `targetGas` | 15_000_000 | rolling target for fee adjustment |
| `baseFeeChangeDenominator` | 36 | higher = smoother base-fee moves |
| `minBlockGasCost` | 0 | |
| `maxBlockGasCost` | 1_000_000 | |
| `blockGasCostStep` | 200_000 | |

BGAS is valueless, so the point of `minBaseFee` is spam resistance, not
revenue. Only tune it if 1 gwei proves too low (mempool spam) or too high
(drips can't cover a normal tx).

## Change the fee config

From the cold admin key (do it from an air-gapped/offline signer if your custody
policy requires; otherwise a short, supervised session):

```sh
# hardhat console --network benzonet, signed by benzo-admin-cold:
const fm = await ethers.getContractAt(
  "IFeeManager", "0x0200000000000000000000000000000000000003", coldSigner);
await (await fm.setFeeConfig(
  20_000_000n, 2n, 1_000_000_000n, 15_000_000n, 36n, 0n, 1_000_000n, 200_000n
)).wait();
await fm.getFeeConfig();               // confirm the new values
await fm.getFeeConfigLastChangedAt();  // block number of the change
```

The `FeeConfigChanged` event carries the full new config; the monitoring stack
alerts if `getFeeConfig` drifts from the expected values unexpectedly.

## Rollback

Re-run `setFeeConfig` with the genesis values in the table above. There is no
implicit revert — the last write wins.
