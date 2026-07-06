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
- After `hardhat zkit make`, run `pnpm artifacts:export` to publish each
  circuit's `.wasm` + `.zkey` and manifest into `@benzo/config` for all
  provers.
- License: EncryptedERC is under the Ava Labs Ecosystem License v1.1
  (Avalanche-platform-only). Keep Benzo deployments and demos scoped to Fuji,
  Avalanche C-Chain, or Avalanche L1s.

The local `hardhat zkit make` flow uses `contributions: 0`. Treat its generated
Groth16 setup as a dev trusted setup, not a ceremony. It is acceptable for Fuji
testnet demos only and must not be represented as production ceremony output.
The proving artifacts and downloaded `.ptau` files live under ignored `zkit/`
paths.

## eERC v0.0.4 Semantics Verdicts

`test/eerc/SemanticsHarness.ts` is Benzo's local source of truth for M4 wallet
and console copy. It deploys the converter stack to a Hardhat network with
eERC decimals set to 2 and a 6-decimal tUSDC token, then proves these observed
behaviors:

- **Auditor rotation is event-time encryption, not history re-encryption.**
  A `PrivateTransfer` emitted before `setAuditorPublicKey(B)` keeps
  `auditorAddress == A` and its `auditorPCT` decrypts to the transfer amount
  only with auditor A's key. A `PrivateTransfer` emitted after rotation keeps
  `auditorAddress == B` and decrypts only with auditor B's key. New auditors
  do not decrypt historical transfer events unless they already held the old
  auditor key.
- **6-decimal tUSDC deposits floor into 2-decimal private units and refund the
  remainder as dust.** For token decimals greater than eERC decimals, the
  converter computes `privateUnits = rawAmount / 10^(tokenDecimals -
  eercDecimals)` and `dust = rawAmount % 10^(tokenDecimals - eercDecimals)`.
  It transfers `rawAmount` in, returns `dust` to the depositor, emits
  `Deposit(user, rawAmount, dust, tokenId)`, and increases the encrypted
  balance by `privateUnits`. Example: `10.123456` tUSDC is `10_123_456` raw
  units, so the encrypted balance increases by `1_012` private cents
  (`10.12`) and `3_456` raw units (`0.003456` tUSDC) are returned. AmountText
  must truncate to the eERC scale, not round up.
- **Restore keys are deterministic for deterministic signers.** The SDK-style
  registration message signature derives a byte-identical eERC decryption key
  across fresh contexts for the same wallet, and the restored key decrypts the
  user's encrypted converter balance. Wallets that produce non-reproducible
  signatures still cannot promise restore from wallet alone.

## eERC Converter Deploy

Benzo's Fuji demo converter stack wraps `TestUSDC`, a public faucet token named
`Test USD Coin` with symbol `tUSDC` and 6 decimals. The wallet Add Money flow
can call `faucet()` directly; each address receives 1,000 tUSDC with a 24-hour
per-address cooldown. Owner `mint(address,uint256)` is retained for controlled
test setup only.

Deploy order is strict:

1. Groth16 verifiers from `contracts/verifiers/`: registration, mint, transfer,
   withdraw, burn
2. `Registrar`
3. `TestUSDC`
4. `BabyJubJub` library and `EncryptedERC` in converter mode with 6 eERC
   decimals
5. Dedicated auditor signer registration, then owner
   `setAuditorPublicKey(auditor)`

The numbered scripts are idempotent and merge into
`deployments/<network>.json` without clobbering unrelated records:

```bash
pnpm hardhat run scripts/deploy/01-verifiers.ts --network fuji
pnpm hardhat run scripts/deploy/02-registrar.ts --network fuji
pnpm hardhat run scripts/deploy/03-tusdc.ts --network fuji
pnpm hardhat run scripts/deploy/04-eerc-converter.ts --network fuji
pnpm hardhat run scripts/deploy/05-auditor.ts --network fuji
```

The one-shot Fuji command is:

```bash
RPC_URL=<fuji-rpc> PRIVATE_KEY=<deployer-key> PRIVATE_KEY_2=<funded-auditor-key> pnpm deploy:eerc
```

`PRIVATE_KEY` owns `TestUSDC` and `EncryptedERC`. `PRIVATE_KEY_2` is a funded
dedicated auditor signer used to register the generated BabyJubJub auditor
public key. The script writes the BabyJubJub private half to ignored
`contracts/.auditor-key.local.json` (it is never printed to stdout, to keep it
out of CI logs and terminal history); M3 sealed storage must import that value
later. Never commit this file.

For Fuji, each deployment record includes address, deployer, transaction hash,
block number, verification status, and a testnet Snowtrace address link. The
stack lands under `contracts.eercConverter` in `deployments/fuji.json`, including
`verifiers`, `registrar`, `testUSDC`, `libraries.babyJubJub`, `encryptedERC`,
`wrappedToken`, and `auditor`.

Routescan verification is attempted after each Fuji deployment record is
persisted. A verification failure leaves the address and transaction hash in
`deployments/fuji.json` with `verified: false` so the operator can retry without
redeploying (Routescan can index a fresh contract minutes after deploy, so a
first-attempt failure often just needs a re-run). To skip the verification step
entirely — for example when Routescan hasn't indexed the just-deployed contracts
yet — set `SKIP_VERIFY=1` on the command and verify later:

```bash
SKIP_VERIFY=1 RPC_URL=<fuji-rpc> PRIVATE_KEY=<deployer-key> PRIVATE_KEY_2=<funded-auditor-key> pnpm deploy:eerc
```

The live Fuji stack recorded here is fully verified: all nine contracts show
`verified: true` with a `verifiedAt` timestamp and have browsable source on
Snowtrace.

After the Fuji deploy, run the end-to-end smoke:

```bash
RPC_URL=<fuji-rpc> PRIVATE_KEY=<deployer-key> PRIVATE_KEY_2=<funded-auditor-key> pnpm smoke:eerc
```

The smoke registers the deployer as a user, calls the public `tUSDC.faucet()`,
approves and deposits into eERC, privately transfers to the registered auditor
key, withdraws a portion, and asserts both public tUSDC balances and decrypted
eERC balances. If rerunning against the same deployer account, pass the original
`SMOKE_SENDER_BABYJUB_PRIVATE_KEY` because `Registrar` does not allow re-keying.
`tUSDC.faucet()` also enforces a 24-hour per-address cooldown, so a rerun within
that window can't top the sender up again — either wait for the cooldown to
expire or point the smoke at a fresh, funded sender address. (The smoke tolerates
a cooldown revert and continues if the sender still holds enough tUSDC.)

### Also deployed on BenzoNet (the permissioned L1)

The identical converter stack is deployed on **BenzoNet**, Benzo's sovereign
Avalanche L1 (chain id `68420`), so encrypted balances run on a gated chain —
the two privacy primitives stacked. Same tooling, a `benzonet` Hardhat network:

```bash
BENZONET_RPC_URL=<l1-rpc> BENZONET_CHAIN_ID=68420 SKIP_VERIFY=1 \
  PRIVATE_KEY=<deployer-key> PRIVATE_KEY_2=<funded-auditor-key> pnpm deploy:benzonet
```

The deployer must be on BenzoNet's deployer allowlist and the deployer/auditor
accounts funded with BGAS (both hold a genesis allocation). The stack is
recorded in [`deployments/benzonet.json`](deployments/benzonet.json); the L1
itself is in [`../infra/benzonet-fuji.json`](../infra/benzonet-fuji.json).

## Circuit Artifact Pipeline

The eERC SDK generates Groth16 proofs from circuit artifacts served to the
prover. Benzo keeps those artifacts generated, ignored, and integrity-checked:

```bash
pnpm hardhat zkit make && pnpm artifacts:export
pnpm artifacts:verify
```

Run those commands from `contracts/`. `artifacts:export` reads
`contracts/zkit/artifacts/` and writes the shared proving bundle to:

```text
packages/config/public/circuits/
  registration.wasm
  registration.zkey
  transfer.wasm
  transfer.zkey
  mint.wasm
  mint.zkey
  withdraw.wasm
  withdraw.zkey
  burn.wasm
  burn.zkey
  manifest.json
```

`manifest.json` is a generated array with one entry per artifact:

```ts
{
  circuit: "registration" | "transfer" | "mint" | "withdraw" | "burn";
  file: "registration.wasm" | "registration.zkey" | "...";
  sha256: string;
  bytes: number;
  zkitVersion: string;
  circomVersion: "2.1.9";
  upstreamTag: "v0.0.4";
  builtAt: string;
}
```

Git strategy: neither `contracts/zkit/` nor
`packages/config/public/circuits/` is committed. CI and local dev regenerate
with `pnpm hardhat zkit make && pnpm artifacts:export`, then run
`pnpm artifacts:verify`. Any missing file, byte-size drift, or SHA-256 drift is
a hard failure.

The manifest records exact byte counts for the current build. Current generated
sizes with `@solarity/hardhat-zkit` 0.5.18, circom 2.1.9, and upstream v0.0.4:

| Circuit | `.wasm` bytes | `.zkey` bytes |
| --- | ---: | ---: |
| registration | 1,882,087 | 1,072,784 |
| transfer | 2,049,197 | 15,132,544 |
| mint | 2,734,086 | 10,567,988 |
| withdraw | 1,985,692 | 7,131,820 |
| burn | 2,002,607 | 10,138,808 |

Expect the first proof for an operation to pay a network download plus browser
parse/compile cost for that operation's `.wasm` and `.zkey`. Wallet and console
flows should lazy-load the operation being performed instead of preloading every
circuit.

All provers consume this through `@benzo/config`, not hand-written paths. Browser
apps must expose `packages/config/public/circuits/` at `/circuits`; the
server-side payroll runner can read the same manifest from the package
workspace during its build/deploy step.

The SDK `circuitURLs` object is per operation, with `wasm` and `zkey` URLs:

```ts
import { buildCircuitURLs } from "@benzo/config";

const circuitURLs = buildCircuitURLs("/circuits");
// {
//   registration: {
//     wasm: "/circuits/registration.wasm",
//     zkey: "/circuits/registration.zkey",
//   },
//   transfer: {
//     wasm: "/circuits/transfer.wasm",
//     zkey: "/circuits/transfer.zkey",
//   },
//   mint: { wasm: "/circuits/mint.wasm", zkey: "/circuits/mint.zkey" },
//   withdraw: {
//     wasm: "/circuits/withdraw.wasm",
//     zkey: "/circuits/withdraw.zkey",
//   },
//   burn: { wasm: "/circuits/burn.wasm", zkey: "/circuits/burn.zkey" },
// }
```

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

## InvoiceRegistry

`contracts/benzo/InvoiceRegistry.sol` stores commitment-only B2B payment
requests. The invoice preimage is built by the M3 BFF/apps and shared with the
payer off-chain:

```solidity
keccak256(abi.encode(amount, token, payee, invoiceSalt))
```

Only the resulting `bytes32 commitment` is stored on-chain. `payer ==
address(0)` marks an open invoice; a non-zero payer records a restricted payer
for workflow coordination. The registry has no payment function, so payer
restriction is metadata for the off-chain flow, not a transfer authorization
check.

| Registry can verify | Registry cannot verify |
| --- | --- |
| `msg.sender` is the payee for `cancelInvoice` and `markPaid` | Any eERC transfer occurred |
| State-machine transitions: `Created -> Paid` or `Created -> Cancelled` | The amount or token represented by a commitment |
| Invoice timestamps and lazy expiry via `isExpired(id)` | That `paymentRef` belongs to the invoice |
| Commitment immutability after creation | That an encrypted transfer amount matches the invoice |

`markPaid(id, paymentRef)` is strictly a payee attestation. `paymentRef` is
unverified bookkeeping, expected to be the eERC transfer transaction hash the
payee observed off-chain after decrypting their own balance change. Late
acknowledgement after expiry is allowed; cancelled invoices can never be marked
paid.

## Gift Links

Benzo ships two gift-link tiers. The tiers are intentionally different products:
Tier A is public-token escrow, while Tier B is an SDK-level private eERC flow.
UI copy must not blur those guarantees.

| Tier | Flow | What is private | What is public or not enforced |
| --- | --- | --- | --- |
| A - `GiftEscrow` public tUSDC | Sender creates `createGift(claimAddress, amount, expiry)`, escrowing tUSDC. The link carries the ephemeral private key for `claimAddress`. Before expiry, the claimant signs the recipient-bound claim digest and calls `claim(giftId, recipient, sig)`. At or after expiry, only the sender can refund. | Only the claim secret in the link. | Amount, sender, token timing, claim, recipient, and refund are public on-chain. Senders must see copy like "this amount will be visible on-chain." |
| B - private eERC bearer link | Sender registers an ephemeral address in the eERC `Registrar`, privately transfers encrypted balance to it, serializes a link containing the ephemeral EVM private key and eERC decryption key, and the claimant privately transfers from the ephemeral address to their own registered address. | Amount is encrypted by eERC. Sender and claimant balances remain decryptable only by their keys and the auditor key. | Ephemeral address and transfer existence are public. The link is a bearer secret. There is no on-chain expiry or refund enforcement. The sender retains the ephemeral key and can sweep back any time, so sender and claimant can race. Funding the ephemeral address with gas AVAX creates public metadata; claimant-funded gas avoids a public sender -> ephemeral funding link. |

`GiftEscrow` verifies a raw ECDSA signature over:

```solidity
keccak256(abi.encode(address(this), block.chainid, giftId, recipient))
```

Binding `recipient` prevents a mempool observer from copying a revealed secret
and redirecting the claim. A raw secret-reveal claim design would be stealable.

Deploy and Routescan-verify the public escrow tier on Fuji after the tUSDC
deployment address is available:

```bash
pnpm deploy:gift-escrow
```

The deploy script reads the token from `GIFT_ESCROW_TOKEN_ADDRESS`,
`TUSDC_ADDRESS`, `TEST_USDC_ADDRESS`, `USDC_ADDRESS`, or a matching tUSDC entry
in `deployments/fuji.json`, then writes the verified `GiftEscrow` deployment
metadata back to that file.

Run the private bearer-link Fuji exercise after the converter stack, circuits,
and registered/funded sender balance are available:

```bash
pnpm gift:private-e2e
```

The script needs Fuji `Registrar`, `EncryptedERC`, and tUSDC addresses from
environment variables or `deployments/fuji.json`. It also needs two funded Fuji
accounts (`PRIVATE_KEY` and `PRIVATE_KEY_2`). For already registered accounts,
provide their eERC decryption keys with
`PRIVATE_GIFT_SENDER_EERC_PRIVATE_KEY` and
`PRIVATE_GIFT_CLAIMANT_EERC_PRIVATE_KEY` so the script can generate valid
proofs and assert decrypted balances. It writes the serialized bearer payload to
`contracts/.gift-link.local.txt`, prints only that file path plus a masked
preview, and prints the before/after decrypted balances:

```text
gift link payload file: .gift-link.local.txt
gift link payload preview: eyJjaGFp...fSJ9
WARNING: the gift link payload file is a bearer secret; do not commit, share, or upload it.
```

The payload file is gitignored because it contains the ephemeral EVM private key
and eERC decryption key. Treat it as a bearer secret.

The script funds the newly generated ephemeral wallet from `PRIVATE_KEY_2`
before ephemeral eERC registration, then checks the same gas floor again before
the final private-transfer sweep. `PRIVATE_GIFT_MIN_EPHEMERAL_AVAX` defaults to
`0.02`, sized to cover both transactions on Fuji; raise it if gas prices or
proof-verification costs increase.

## Commands

```bash
pnpm compile        # hardhat compile
pnpm test           # hardhat test
pnpm artifacts:export # export zkit .wasm/.zkey into @benzo/config
pnpm artifacts:verify # verify exported bytes against manifest.json
pnpm zkit:make      # hardhat zkit make
pnpm zkit:verifiers # hardhat zkit verifiers
pnpm deploy:eerc    # deploy verifiers, Registrar, TestUSDC, converter eERC, auditor on Fuji
pnpm smoke:eerc     # run faucet -> deposit -> private transfer -> withdraw on Fuji
pnpm deploy:handle-registry   # hardhat run scripts/deploy/06-handle-registry.ts --network fuji
pnpm deploy:invoice-registry  # hardhat run scripts/deploy/07-invoice-registry.ts --network fuji
pnpm deploy:gift-escrow       # hardhat run scripts/deploy/08-gift-escrow.ts --network fuji
pnpm gift:private-e2e         # hardhat run scripts/gift/private-gift-e2e.ts --network fuji
```

Verification on testnet.snowtrace.io works via Routescan with the
placeholder API key already wired in `hardhat.config.ts`:

```bash
pnpm hardhat verify --network fuji <address> [constructor args]
```
