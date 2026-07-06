# EncryptedERC Vendor Record

Benzo vendors Ava Labs EncryptedERC source directly, without a git submodule, so
the private-transfer layer is pinned and reviewable in this repository.

- Upstream repository: https://github.com/ava-labs/EncryptedERC
- Upstream tag: `v0.0.4`
- Upstream commit: `c7eb0e09bc9315e68c35d3c09f5dce4b794d0485`
- Vendored on: 2026-07-06
- License: Ava Labs Ecosystem License v1.1, preserved at `LICENSE.md`

## Vendored Files

- Solidity eERC sources from upstream `contracts/` are under
  `contracts/contracts/eerc/`.
- Circuit sources from upstream `circom/` are under `contracts/circuits/`.
  Generated upstream `circom/build/` proving artifacts were intentionally not
  vendored.
- Upstream TypeScript proof/test helpers from `src/` are under `contracts/src/`.
- Upstream Hardhat tests from `test/` are under `contracts/test/eerc/`.

## Local Deviations

The test suite behavior is unchanged. Imports and linked-library source names
were adjusted only because Benzo vendors eERC under `contracts/eerc/` and keeps
the ported tests in `test/eerc/`.
