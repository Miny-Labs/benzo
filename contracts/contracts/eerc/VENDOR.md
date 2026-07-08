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
- The circomlib sources under `contracts/circuits/circomlib/` are vendored from
  `iden3/circomlib`, are licensed GPL-3.0, and remain unmodified. This
  provenance is distinct from the Ava Labs Ecosystem License covering the eERC
  sources above.
- Upstream TypeScript proof/test helpers from `src/` are under `contracts/src/`.
- Upstream Hardhat tests from `test/` are under `contracts/test/eerc/`.

## Local Deviations

Imports and linked-library source names were adjusted because Benzo vendors eERC
under `contracts/eerc/` and keeps the ported tests in `test/eerc/`. Additional
source and regression-test changes are recorded under "Benzo patches" below.

## Trusted setup scope

`contracts/hardhat.config.ts` sets zkit `contributions: 0`, which produces a
development Groth16 setup rather than ceremony output. Any verifiers generated
into `contracts/verifiers/` from that flow are TESTNET-ONLY and must never back
a mainnet deployment.

This checkout does not include an executable deploy script. If one is added, it
must reject Avalanche C-Chain mainnet (`43114`) and any non-Fuji/non-local
network before deploying these generated verifiers.

## Known upstream behavior (accepted)

`BabyJubJub.elGamalEncryption` uses a fixed `random = 1` for on-chain
encryption. Benzo accepts this upstream behavior because the on-chain callers
are converter-mode deposit and withdraw paths, where the amounts are already
public through `Deposit` and `Withdraw` events. Private transfers use
client-side randomness instead.

The deterministic ciphertext accumulation can reveal deposit count until the
first private operation, but that count is already public via events, and the
balance is re-randomized after any private transfer.

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
- `contracts/contracts/eerc/EncryptedERC.sol`: changed the metadata
  `privateBurn(address,...)` registration guard to check `msg.sender` instead
  of the legacy `user` argument, matching the internal `_executePrivateBurn`
  behavior and the non-metadata burn overload. Review source: post-merge
  CodeRabbit/Greptile follow-up on PR #66.
- `contracts/test/eerc/EncryptedERC-Standalone.ts`: added a regression test
  proving an unregistered caller cannot pass a different registered `user` to
  satisfy the metadata burn overload's registration guard. Review source:
  post-merge CodeRabbit/Greptile follow-up on PR #66.
- `contracts/contracts/eerc/EncryptedERC.sol` + `errors/Errors.sol`: added an
  owner-authorized **deposit-on-behalf** path (`depositFor`). Stock upstream
  `_executeDeposit` hardcodes `to = msg.sender`, so a caller can only fund its
  OWN encrypted balance. Benzo adds `mapping authorizedDepositors` +
  `setAuthorizedDepositor(address,bool)` (onlyOwner) + `onlyAuthorizedDepositor`
  modifier + `NotAuthorizedDepositor` error + `AuthorizedDepositorSet` event, and
  refactors `_executeDeposit` into `_executeDepositFrom(payer, to, ...)` so the
  self-deposit path (`payer == to == msg.sender`) is byte-for-byte unchanged.
  `depositFor(to, amount, token, amountPCT, message)` pulls the ERC20 from
  msg.sender (an authorized depositor), credits `to` via the unchanged
  `_convertFrom`, returns dust to the payer, and emits the existing `Deposit(to,
  ...)` event (indexer-compatible). Guards: `onlyIfAuditorSet`,
  `onlyForConverter`, `revertIfBlacklisted`, `onlyIfUserRegistered(to)`,
  `onlyAuthorizedDepositor`. No ZK proof (deposit is proofless upstream; the eGCT
  is derived on-chain from `to`'s registered public key). `amountPCT` is the
  recipient-supplied transaction-history entry and is NOT verified against the
  eGCT — a CCTP-fee amount mismatch is cosmetic history drift only, never a
  balance error. Enables the CCTP onramp router (#108) and PrivateGiftEscrow
  (#117). Review source: issue #105.
- `contracts/test/deposit-for.test.ts`: exhaustive coverage of the deposit-on-
  behalf path — credits `to` (verified by decrypting to the exact amount) while
  pulling from the caller, dust returns to the payer, and every revert path
  (non-authorized caller, unregistered `to`, unset auditor, blacklisted token,
  standalone mode). Review source: issue #105.
