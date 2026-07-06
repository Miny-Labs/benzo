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

## Commands

```bash
pnpm compile        # hardhat compile
pnpm test           # hardhat test
pnpm zkit:make      # hardhat zkit make
pnpm zkit:verifiers # hardhat zkit verifiers
pnpm deploy:fuji    # hardhat run scripts/deploy.ts --network fuji
```

Verification on testnet.snowtrace.io works via Routescan with the
placeholder API key already wired in `hardhat.config.ts`:

```bash
pnpm hardhat verify --network fuji <address> [constructor args]
```
