# @benzo/contracts

Hardhat workspace targeting Avalanche Fuji (chain id 43113). Currently a
compile-checked scaffold; the eERC integration lands here.

## eERC integration plan

Vendor [`ava-labs/EncryptedERC`](https://github.com/ava-labs/EncryptedERC)
v0.0.4 (or follow the
[`eerc-backend-converter`](https://github.com/alejandro99so/eerc-backend-converter)
layout from the Builder Hub course):

- Solidity 0.8.27, OpenZeppelin 5.x; circuits compiled with
  `@solarity/hardhat-zkit` (circom 2.1.9, Groth16).
- **Converter mode** wraps an ERC-20 for deposit/withdraw + private
  transfers; standalone mode mints a native private token.
- Deploy order: verifiers → `Registrar` → `EncryptedERC` →
  `setAuditorPublicKey`. Private ops revert until the auditor key is set.
- After `hardhat zkit make`, copy each circuit's `.wasm` + `.zkey` into the
  frontend's `public/` for the SDK's `circuitURLs`.
- License: EncryptedERC is under the Ava Labs Ecosystem License v1.1
  (Avalanche-platform-only).

## Commands

```bash
pnpm compile        # hardhat compile
pnpm test           # hardhat test
pnpm deploy:fuji    # hardhat run scripts/deploy.ts --network fuji
```

Verification on testnet.snowtrace.io works via Routescan with the
placeholder API key already wired in `hardhat.config.ts`:

```bash
pnpm hardhat verify --network fuji <address> [constructor args]
```
