#![no_std]

//! Benzo compliance registry (viewkey anchor).
//!
//! Records, per shielded note, the binding between the note's MVK tag
//! (`tag = Poseidon2(mvk_pub, blinding)`, enforced in-circuit at shield and
//! transfer time) and the MVK-encrypted disclosure ciphertext. Also registers
//! time-scoped Transaction Viewing Key (TVK) grants for auditors.
//!
//! All viewing-key cryptography (HKDF MVK→TVK derivation, X25519 + AES-GCM)
//! happens off-chain; this contract is the on-chain anchor that (a) proves a
//! binding existed at a ledger time, and (b) gives auditors a canonical place
//! to discover their scoped grants. Viewing keys are decrypt-only: nothing
//! registered here ever carries spend authority.

use soroban_sdk::{
    Address, Bytes, Env, U256, contract, contracterror, contractevent, contractimpl, contracttype,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract is not initialized
    NotInitialized = 1,
    /// No such auditor grant
    GrantNotFound = 2,
}

#[contracttype]
#[derive(Clone, Debug)]
enum DataKey {
    /// Operator (pool) allowed to record bindings
    Operator,
    /// Admin allowed to scope auditors (the disclosing entity)
    Admin,
    /// MVK binding ciphertext for a note tag
    Binding(U256),
    /// TVK grant for an auditor address
    Grant(Address),
}

/// A time-scoped TVK grant for a passive auditor.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TvkGrant {
    /// TVK ciphertext, encrypted to the auditor's key (X25519 sealed box)
    pub tvk_ct: Bytes,
    /// Scope label, e.g. "2026-Q2/corridor=ALL" (matches the HKDF info input)
    pub scope: Bytes,
    /// Ledger timestamp after which the grant is void
    pub expiry: u64,
}

/// Emitted when a note tag is bound to an MVK ciphertext.
#[contractevent]
#[derive(Clone)]
pub struct MvkBoundEvent {
    /// The note's MVK tag (Poseidon2(mvk_pub, blinding))
    #[topic]
    pub tag: U256,
    /// MVK-encrypted note disclosure ciphertext
    pub mvk_ct: Bytes,
}

/// Emitted when an auditor is granted a scoped TVK.
#[contractevent]
#[derive(Clone)]
pub struct AuditorScopedEvent {
    /// Auditor address
    #[topic]
    pub auditor: Address,
    /// Scope label
    pub scope: Bytes,
    /// Expiry (unix seconds)
    pub expiry: u64,
}

#[contract]
pub struct BenzoViewkeyAnchor;

#[contractimpl]
impl BenzoViewkeyAnchor {
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

    /// Record a note-tag → MVK ciphertext binding. Operator (pool) only.
    pub fn bind_mvk(env: Env, tag: U256, mvk_ct: Bytes) -> Result<(), Error> {
        let operator: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Operator)
            .ok_or(Error::NotInitialized)?;
        operator.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Binding(tag.clone()), &mvk_ct);
        MvkBoundEvent { tag, mvk_ct }.publish(&env);
        Ok(())
    }

    /// Fetch the MVK binding ciphertext for a note tag.
    pub fn get_binding(env: Env, tag: U256) -> Option<Bytes> {
        env.storage().persistent().get(&DataKey::Binding(tag))
    }

    /// Grant an auditor a time-scoped TVK. Admin (disclosing entity) only.
    pub fn scope_auditor(
        env: Env,
        auditor: Address,
        tvk_ct: Bytes,
        scope: Bytes,
        expiry: u64,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        let grant = TvkGrant {
            tvk_ct,
            scope: scope.clone(),
            expiry,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Grant(auditor.clone()), &grant);
        AuditorScopedEvent {
            auditor,
            scope,
            expiry,
        }
        .publish(&env);
        Ok(())
    }

    /// Fetch an auditor's grant if present and unexpired.
    pub fn get_grant(env: Env, auditor: Address) -> Result<TvkGrant, Error> {
        let grant: TvkGrant = env
            .storage()
            .persistent()
            .get(&DataKey::Grant(auditor))
            .ok_or(Error::GrantNotFound)?;
        if grant.expiry < env.ledger().timestamp() {
            return Err(Error::GrantNotFound);
        }
        Ok(grant)
    }
}

#[cfg(test)]
mod test;
