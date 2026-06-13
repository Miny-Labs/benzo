#![cfg(test)]

use super::*;
use soroban_sdk::{
    Address, Bytes, Env, U256,
    testutils::{Address as _, Ledger},
};

fn setup() -> (Env, BenzoViewkeyAnchorClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let contract_id = env.register(BenzoViewkeyAnchor, (admin,));
    let client = BenzoViewkeyAnchorClient::new(&env, &contract_id);
    client.set_operator(&operator);
    (env, client)
}

#[test]
fn bind_and_get_mvk_binding() {
    let (env, client) = setup();
    let tag = U256::from_u32(&env, 99);
    let ct = Bytes::from_array(&env, &[1, 2, 3, 4]);
    client.bind_mvk(&tag, &ct);
    assert_eq!(client.get_binding(&tag), Some(ct));
    assert_eq!(
        client.get_binding(&U256::from_u32(&env, 100)),
        None
    );
}

#[test]
fn auditor_grant_lifecycle_and_expiry() {
    let (env, client) = setup();
    env.ledger().set_timestamp(1_000);

    let auditor = Address::generate(&env);
    let tvk_ct = Bytes::from_array(&env, &[9, 9, 9]);
    let scope = Bytes::from_slice(&env, b"2026-Q2/corridor=ALL");
    client.scope_auditor(&auditor, &tvk_ct, &scope, &2_000u64);

    let grant = client.get_grant(&auditor);
    assert_eq!(grant.tvk_ct, tvk_ct);
    assert_eq!(grant.scope, scope);
    assert_eq!(grant.expiry, 2_000);

    // After expiry the grant is gone.
    env.ledger().set_timestamp(3_000);
    let res = client.try_get_grant(&auditor);
    assert_eq!(res, Err(Ok(Error::GrantNotFound)));

    // Unknown auditor.
    let unknown = Address::generate(&env);
    let res = client.try_get_grant(&unknown);
    assert_eq!(res, Err(Ok(Error::GrantNotFound)));
}
