# @benzo/contracts

Hardhat workspace targeting Avalanche Fuji (chain id 43113). This workspace
vendors Ava Labs EncryptedERC v0.0.4 for Benzo's private USDC payment layer.

## Vendored eERC

[`ava-labs/EncryptedERC`](https://github.com/ava-labs/EncryptedERC) is vendored
under `contracts/eerc/`; the exact upstream tag and commit are recorded in
`contracts/eerc/VENDOR.md`.

- Solidity 0.8.27, OpenZeppelin 5.x; circuits compiled with
  `@solarity/hardhat-zkit` (circom 2.1.9, Groth16).
- **Converter mode** wraps an ERC-20 for deposit/withdraw + private
  transfers; standalone mode mints a native private token.
- Deploy order: verifiers → `Registrar` → `EncryptedERC` →
  `setAuditorPublicKey`. Private ops revert until the auditor key is set.
- After `hardhat zkit make`, copy each circuit's `.wasm` + `.zkey` into the
  frontend's `public/` for the SDK's `circuitURLs`.
- License: EncryptedERC is under the Ava Labs Ecosystem License v1.1
  (Avalanche-platform-only). Keep Benzo deployments and demos scoped to Fuji,
  Avalanche C-Chain, or Avalanche L1s.

The local `hardhat zkit make` flow uses `contributions: 0`. Treat its generated
Groth16 setup as a dev trusted setup, not a ceremony. It is acceptable for Fuji
testnet demos only and must not be represented as production ceremony output.
The proving artifacts and downloaded `.ptau` files live under ignored `zkit/`
paths.

The ported upstream tests live in `test/eerc/`. Their only local deviations are
path/import updates required by Benzo's `contracts/eerc/` vendor directory.

## Handle Registry

`contracts/benzo/HandleRegistry.sol` is the on-chain source of truth for
Benzo `@handle` resolution. Handles are claimed first-come-first-served with no
admin, fees, reservations, or dispute process. Squatting is an accepted demo
tradeoff.

Privacy claims - stated precisely: the handle -> address mapping is fully
public by design; claiming a handle deliberately links a human-readable
identity to an address. eERC keeps that address's balances and transfer amounts
encrypted, but its transaction graph (who it interacted with, when) remains
public metadata. The contract makes no privacy claim beyond what eERC provides
to the underlying address.

Handles are validated byte-by-byte on-chain: 3-32 bytes, `[a-z0-9_]` only, and
no normalization. Uppercase and unicode bytes revert.

The on-chain `HandleRegistry` is the single source of truth. Any backend handle
table is only a write-through cache populated by the indexer; claim flows must
go through the contract. Resolution endpoints must state whether they serve
chain state or indexed cache state. If cache data conflicts with contract state,
the contract wins and the cache must be repaired from indexed events.

Deploy and Routescan-verify on Fuji:

```bash
pnpm hardhat run scripts/deploy/06-handle-registry.ts --network fuji
```

The deploy script updates `deployments/fuji.json` with the deployed
`handleRegistry` address. `deployments/benzonet.json` is intentionally left for
the later BenzoNet deploy step.

## Commands

```bash
pnpm compile        # hardhat compile
pnpm test           # hardhat test
pnpm zkit:make      # hardhat zkit make
pnpm zkit:verifiers # hardhat zkit verifiers
pnpm deploy:fuji    # hardhat run scripts/deploy/06-handle-registry.ts --network fuji
```

Verification on testnet.snowtrace.io works via Routescan with the
placeholder API key already wired in `hardhat.config.ts`:

```bash
pnpm hardhat verify --network fuji <address> [constructor args]
```
