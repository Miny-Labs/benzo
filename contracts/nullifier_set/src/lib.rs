#![no_std]

//! Benzo nullifier set — double-spend prevention.
//!
//! Each spent nullifier is its own **persistent** storage entry (never
//! temporary: temporary entries are reaped at TTL expiry, which would
//! silently re-enable double-spends — CAP-0078 archival rules).
//!
//! Following Umbra's three-role model, `spend` is **idempotent**: marking an
//! already-spent nullifier returns `false` (not newly spent) instead of
//! panicking, so honest relayer retries converge. The pool decides tx-level
//! semantics: a fully-replayed transaction is a no-op success, a partial
//! replay (some nullifiers spent, some fresh) is rejected.

use soroban_sdk::{
    Address, Env, U256, contract, contracterror, contractevent, contractimpl, contracttype,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract is not initialized
    NotInitialized = 1,
}

#[contracttype]
#[derive(Clone, Debug)]
enum DataKey {
    /// Administrator (may set the operator)
    Admin,
    /// Operator (pool) allowed to spend nullifiers
    Operator,
    /// A spent nullifier (presence == spent); persistent storage only
    Nullifier(U256),
}

/// Emitted when a nullifier is newly spent.
#[contractevent]
#[derive(Clone)]
pub struct NullifierSpentEvent {
    /// The nullifier value
    #[topic]
    pub nullifier: U256,
}

#[contract]
pub struct BenzoNullifierSet;

#[contractimpl]
impl BenzoNullifierSet {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().persistent().set(&DataKey::Admin, &admin);
    }

    /// Set the operator (the pool contract). Admin-only.
    pub fn set_operator(env: Env, operator: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Operator, &operator);
        Ok(())
    }

    /// True if the nullifier has been spent.
    pub fn is_spent(env: Env, nullifier: U256) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    /// Mark a nullifier as spent. Idempotent: returns `true` if newly spent,
    /// `false` if it was already spent (never panics). Operator-only.
    pub fn spend(env: Env, nullifier: U256) -> Result<bool, Error> {
        let operator: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Operator)
            .ok_or(Error::NotInitialized)?;
        operator.require_auth();

        let key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&key) {
            return Ok(false);
        }
        env.storage().persistent().set(&key, &true);
        NullifierSpentEvent { nullifier }.publish(&env);
        Ok(true)
    }
}

#[cfg(test)]
mod test;
