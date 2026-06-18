# Capability matrix — ZK host functions by network

Benzo treats advanced cryptography as **capability-gated** (per the Stellar ZK
guidance): the contracts call native host functions that only exist on Protocol
25+, so a target network must be verified before deployment. `scripts/deploy-testnet.sh`
preflights the network protocol version and **aborts if < 25**.

## Host functions Benzo depends on

| Capability | CAP | Host function | Used by |
|---|---|---|---|
| BN254 pairing + curve ops | [CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md) | `env.crypto().bn254()` (pairing_check, MSM, scalar arith, subgroup checks) | `verifier_groth16` (Groth16 verification) |
| Poseidon2 hash | [CAP-0075](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md) | `crypto_hazmat.poseidon2_permutation` | `merkle`, `asp_*`, `*_registry`, `soroban-utils` (commitments, nullifiers, tree nodes) |
| BLS12-381 | [CAP-0059](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md) | `env.crypto().bls12_381()` | not currently used (BN254 is the proving curve); listed for completeness |

## Network support matrix

> Status is protocol- and SDK-version dependent — **always re-verify CAP status +
> network protocol version before relying on a primitive** (the ZK skill's
> source-of-truth rule). Check: <https://developers.stellar.org/docs/networks/software-versions>

| Network | Protocol | CAP-0074 (BN254) | CAP-0075 (Poseidon2) | Benzo deployable |
|---|---|---|---|---|
| **Testnet** | ≥ 25 (X-Ray) / 26 (Yardstick) | ✅ | ✅ | ✅ (current deployment) |
| **Futurenet** | tracks latest | verify | verify | when ≥ 25 |
| **Mainnet** | verify current | verify | verify | only when both CAPs are live + a real ceremony has run (see SECURITY.md) |
| Local quickstart | image-dependent | only if image ≥ 25 | only if image ≥ 25 | use a P25+ image |

## Fail-loud behavior

- **Deploy time:** `deploy-testnet.sh` queries `getNetwork` and aborts with a clear
  message if `protocolVersion < 25`, rather than trapping opaquely on the first
  on-chain verify.
- **Runtime:** on a network missing these CAPs the host functions trap; the pool's
  cross-contract call to the verifier surfaces that as a failed transaction (fail-closed,
  no state mutation). Soundness is never degraded — at worst the action is unavailable.

## Pinned proving stack (off-chain)

- circom 2.2.x · snarkjs 0.7.6 · Groth16 over BN254 · ptau `powersOfTau28_hez_final_16` (2^16)
- Poseidon2 params pinned in [`circuits/poseidon_params/poseidon2_bn254.json`](../circuits/poseidon_params/poseidon2_bn254.json),
  byte-identical to the on-chain host function (CI guard regenerates from circom source and fails on drift).
