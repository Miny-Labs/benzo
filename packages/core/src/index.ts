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
export * from "./notes.js";
export * from "./merkle.js";
export * from "./prover.js";
export * from "./viewkeys.js";
export * from "./stellar.js";
export * from "./stellar-rpc.js";
export * from "./reserves.js";
export * from "./onboard.js";
export * from "./balance.js";
export * from "./scanner.js";
export * from "./store.js";
export * from "./pool.js";
export * from "./account.js";
export * from "./account-file.js";
export * from "./client.js";
