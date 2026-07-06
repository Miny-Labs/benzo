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

## Benzo patches

- `contracts/contracts/eerc/Registrar.sol`: changed the duplicate-registration
  guard from `isRegistered[registrationHash] && isUserRegistered(account)` to
  `||`; prevents an already-registered address from submitting a fresh valid
  registration proof with a new keypair and overwriting its public key. Review
  source: PR #66 verified finding 1.
- `contracts/src/jub/jub.ts`: replaced the `/ 100n` fallback in
  `encryptMessage` with rejection sampling below `BASE_POINT_ORDER`; removes
  biased ElGamal encryption randomness. Review source: PR #66 verified finding
  2.
- `contracts/src/poseidon/poseidon.ts`: replaced the `/ 10n` fallback in
  `processPoseidonEncryption` with rejection sampling below `BASE_POINT_ORDER`;
  removes biased Poseidon PCT encryption randomness. Review source: PR #66
  verified finding 3.
- `contracts/test/eerc/EncryptedERC-Standalone.ts`: added a regression test
  where an already-registered signer attempts to register a fresh keypair with
  a fresh valid proof; proves the registrar rejects same-account re-keying.
  Review source: PR #66 verified finding 1.
- `contracts/test/eerc/Randomness.ts`: added deterministic RNG-stub tests for
  the rejection-sampling path plus repeated range checks for both randomness
  helpers. Review source: PR #66 verified findings 2 and 3.
