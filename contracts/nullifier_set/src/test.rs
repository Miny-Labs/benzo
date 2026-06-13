#![cfg(test)]

use super::*;
use soroban_sdk::{Address, Env, U256, testutils::Address as _};

fn setup() -> (Env, BenzoNullifierSetClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let contract_id = env.register(BenzoNullifierSet, (admin,));
    let client = BenzoNullifierSetClient::new(&env, &contract_id);
    client.set_operator(&operator);
    (env, client)
}

#[test]
fn spend_is_idempotent() {
    let (env, client) = setup();
    let n = U256::from_u32(&env, 42);

    assert!(!client.is_spent(&n));
    // First spend: newly spent.
    assert_eq!(client.spend(&n), true);
    assert!(client.is_spent(&n));
    // Second spend: idempotent success, not newly spent — never a panic.
    assert_eq!(client.spend(&n), false);
    assert!(client.is_spent(&n));
}

#[test]
fn distinct_nullifiers_are_independent() {
    let (env, client) = setup();
    let a = U256::from_u32(&env, 1);
    let b = U256::from_u32(&env, 2);
    assert_eq!(client.spend(&a), true);
    assert!(!client.is_spent(&b));
    assert_eq!(client.spend(&b), true);
}

/// Nullifiers must live in persistent storage (the soundness invariant).
#[test]
fn nullifier_stored_persistently() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let contract_id = env.register(BenzoNullifierSet, (admin,));
    let client = BenzoNullifierSetClient::new(&env, &contract_id);
    client.set_operator(&operator);

    let n = U256::from_u32(&env, 7);
    client.spend(&n);

    let in_persistent: bool = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(U256::from_u32(&env, 7)))
    });
    assert!(in_persistent, "nullifier must be in persistent storage");
}
