# BenzoNet Infra

BenzoNet is the permissioned PoA Avalanche L1 used for Benzo local iteration. The committed genesis file is the source of truth for chain ID, BGAS fee economics, genesis balances, and precompile access control.

## CLI

Pinned Avalanche CLI:

```sh
curl -sSfL https://raw.githubusercontent.com/ava-labs/avalanche-cli/main/scripts/install.sh | sh -s -- -b "$HOME/bin" v1.9.6
```

Verified local binary for this issue:

```sh
~/bin/avalanche --version
# avalanche version 1.9.6
```

## Chain ID

`68420` was checked against the ChainList data source at `https://chainid.network/chains.json` on 2026-07-06. The check returned `0` matches across `2654` known EVM networks.

## Role Keys

Only public addresses are committed. Private keys are custodied by the operator.

| Role | Address | Genesis BGAS | Genesis permissions |
| --- | --- | ---: | --- |
| benzo-admin-cold | `0x0e68879016b83F76D279aFAeFB1B64C066823AdC` | 1,000,000 | Admin in every precompile; PoA validator-manager owner |
| benzo-deployer | `0x3cdff5fDfe43401BDE629faB735B4C9E29bB12Eb` | 100,000 | `txAllowList` enabled; `contractDeployerAllowList` enabled |
| benzo-ops | `0x13b8d12414dd468a9eCbA24d0a162C17affd6D32` | 100,000 | `txAllowList` manager |
| benzo-dripper | `0xf1ED91B084e0F9EeE5798E9FA8BC40295479836c` | 100,000 | `txAllowList` enabled; `contractNativeMinter` enabled |
| benzo-backend | `0xa0C5455eF9A7D71e9B5b3ce8Cf3C7E06D856bEDB` | 100,000 | `txAllowList` enabled only |

Every precompile admin array includes `benzo-admin-cold`. Empty admin sets are not recoverable in a deployed genesis: if a precompile has no admin, nobody can later grant an admin, manager, enabled, or none role for that precompile, which permanently bricks that control plane for the chain.

## Genesis Files

- `infra/genesis/benzonet.genesis.json` is the Subnet-EVM genesis consumed by `avalanche blockchain create`.
- `infra/benzonet.json` is the human-readable roster and review metadata.

The genesis timestamp and precompile activation timestamp are fixed at `2026-07-06T00:00:00Z` (`1783296000`). Subnet-EVM, Durango, Etna, Fortuna, and Granite timestamps are set to the same value so manager roles and current precompile semantics are active from the genesis block.

## Local Loop

Use a sandboxed CLI home when running from restricted environments:

```sh
export BENZO_AVA_HOME=/tmp/benzo-avacli
mkdir -p "$BENZO_AVA_HOME/.avalanche-cli"
```

Create the blockchain config from the committed genesis:

```sh
HOME="$BENZO_AVA_HOME" ~/bin/avalanche blockchain create benzonet \
  --evm \
  --evm-chain-id 68420 \
  --evm-token BGAS \
  --genesis infra/genesis/benzonet.genesis.json \
  --proof-of-authority \
  --validator-manager-owner 0x0e68879016b83F76D279aFAeFB1B64C066823AdC \
  --force \
  --skip-update-check
```

Deploy locally:

```sh
HOME="$BENZO_AVA_HOME" ~/bin/avalanche blockchain deploy benzonet --local --skip-update-check
```

Reset and reproduce from committed genesis:

```sh
HOME="$BENZO_AVA_HOME" ~/bin/avalanche network clean --skip-update-check
HOME="$BENZO_AVA_HOME" ~/bin/avalanche blockchain deploy benzonet --local --skip-update-check
```

If the local network state must be wiped beyond the CLI-supported clean command, remove the sandboxed CLI home and recreate the blockchain config from genesis:

```sh
rm -rf "$BENZO_AVA_HOME"
mkdir -p "$BENZO_AVA_HOME/.avalanche-cli"
HOME="$BENZO_AVA_HOME" ~/bin/avalanche blockchain create benzonet \
  --evm \
  --evm-chain-id 68420 \
  --evm-token BGAS \
  --genesis infra/genesis/benzonet.genesis.json \
  --proof-of-authority \
  --validator-manager-owner 0x0e68879016b83F76D279aFAeFB1B64C066823AdC \
  --force \
  --skip-update-check
HOME="$BENZO_AVA_HOME" ~/bin/avalanche blockchain deploy benzonet --local --skip-update-check
```

`avalanche network clean --hard` is not available in Avalanche CLI `v1.9.6`; the sandbox-home wipe above is the full-wipe equivalent for this pinned version.

## Static Validation

Validate the committed genesis and roster:

```sh
pnpm --filter @benzo/infra test
```

## Smoke Tests

The smoke script is standalone against any BenzoNet RPC URL. It requires operator-held private keys via environment variables and never reads `.env` files.

```sh
BENZONET_RPC_URL=http://127.0.0.1:9650/ext/bc/<blockchain-id>/rpc \
BENZO_DEPLOYER_PRIVATE_KEY=0x... \
BENZO_DRIPPER_PRIVATE_KEY=0x... \
BENZO_BACKEND_PRIVATE_KEY=0x... \
BENZO_UNLISTED_PRIVATE_KEY=0x... \
pnpm --filter @benzo/infra smoke
```

The smoke script proves:

- configured roles are present on every precompile;
- `benzo-deployer` can deploy a contract;
- `benzo-backend` cannot deploy contracts because it is not enabled on `contractDeployerAllowList`;
- `benzo-dripper` can call `mintNativeCoin`;
- a funded unlisted key is still rejected by `txAllowList`;
- `benzo-backend` cannot call `mintNativeCoin`;
- `benzo-backend` cannot change `feeConfig` through `feeManager`.
