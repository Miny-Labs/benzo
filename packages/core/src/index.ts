/**
 * @benzo/core — headless TypeScript SDK for the Benzo shielded-USDC protocol
 * on Stellar (Soroban).
 *
 * Modules:
 *  - crypto/poseidon2: pinned Poseidon2 BN254 (byte-identical to circuits +
 *    Soroban host function)
 *  - notes: note commitments, nullifiers, keypairs, MVK tags
 *  - merkle: off-chain mirror of the on-chain incremental tree
 *  - prover: headless Groth16 proving via snarkjs (Node, never a browser)
 *  - crypto/groth16: snarkjs -> Soroban encodings
 *  - viewkeys: MVK->TVK hierarchical viewing keys, note discovery AEAD
 *  - stellar: CLI/RPC client
 *  - reserves: sponsored reserves (CAP-33) for gasless onboarding
 *  - pool: high-level client for shield / transfer / unshield
 */

export * from "./crypto/poseidon2.js";
export * from "./crypto/groth16.js";
export * from "./crypto/random.js";
export * from "./crypto/bytes.js";
export * from "./notes.js";
export * from "./merkle.js";
export * from "./mvk-registry.js";
export * from "./prover.js";
export * from "./attestation.js";
export * from "./attestation-node.js";
export * from "./attestation-web.js";
export * from "./prover-factory.js";
export * from "./crypto/ecies.js";
export * from "./viewkeys.js";
export * from "./stellar.js";
export * from "./stellar-rpc.js";
export * from "./scval.js";
export * from "./tx-signer.js";
export * from "./reserves.js";
export * from "./onboard.js";
export * from "./balance.js";
export * from "./sum.js";
export * from "./spendingcap.js";
export * from "./payoutinnocence.js";
export * from "./orgauth.js";
export * from "./payrollcomp.js";
export * from "./kybcredential.js";
export * from "./netting.js";
export * from "./scanner.js";
export * from "./store.js";
export * from "./relay.js";
export * from "./org.js";
export * from "./pool.js";
export * from "./account.js";
export * from "./account-file.js";
export * from "./zklogin.js";
export * from "./client.js";
