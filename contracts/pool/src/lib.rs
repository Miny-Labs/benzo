#![no_std]

//! Benzo pool — value custody and orchestration.
//!
//! The only contract that touches USDC. It custodies the SAC balance,
//! validates Groth16 proofs via the verifier, and orchestrates the Merkle
//! tree, nullifier set, ASP registries and compliance registry through
//! cross-contract calls.
//!
//! Operations (canonical verbs; `unshield` is exposed on-chain as the
//! `withdraw` entrypoint):
//! * `shield`   — public USDC -> shielded note (+ ASP allow-membership proof)
//! * `transfer` — note -> note 2-in/2-out join-split (fully private)
//! * `withdraw` — shielded note -> public USDC (+ proof-of-innocence)

mod pool;

pub use pool::*;

#[cfg(test)]
mod test;
