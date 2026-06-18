extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, U256};

fn setup() -> (Env, BenzoIssuerRegistryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(BenzoIssuerRegistry, (admin.clone(), 16u32));
    (env.clone(), BenzoIssuerRegistryClient::new(&env, &id), admin)
}

#[test]
fn registers_issuer_and_advances_root() {
    let (env, reg, _admin) = setup();
    let root0 = reg.current_root();
    let key_id = U256::from_u32(&env, 123_456);
    let idx = reg.register_issuer(&key_id);
    assert_eq!(idx, 0);
    assert_eq!(reg.next_index(), 1);
    assert_ne!(reg.current_root(), root0, "registering must advance the root");
    assert!(reg.is_registered(&key_id));
    assert!(reg.is_known_root(&reg.current_root()));
}

#[test]
fn rejects_duplicate_issuer() {
    let (env, reg, _admin) = setup();
    let key_id = U256::from_u32(&env, 777);
    reg.register_issuer(&key_id);
    let res = reg.try_register_issuer(&key_id);
    assert!(res.is_err(), "a second registration of the same issuer must fail");
}

#[test]
fn rejects_zero_issuer() {
    let (env, reg, _admin) = setup();
    let res = reg.try_register_issuer(&U256::from_u32(&env, 0));
    assert!(res.is_err(), "the zero key-id must be rejected");
}

#[test]
fn unknown_root_is_rejected() {
    let (env, reg, _admin) = setup();
    assert!(!reg.is_known_root(&U256::from_u32(&env, 1)), "bogus root must be unknown");
    assert!(!reg.is_known_root(&U256::from_u32(&env, 0)), "zero is never a valid root");
}

#[test]
fn pins_and_reads_attested_measurement() {
    let (env, reg, _admin) = setup();
    assert_eq!(reg.attested_measurement(), U256::from_u32(&env, 0), "none pinned initially");
    let m = U256::from_u32(&env, 0xABCD);
    reg.set_attested_measurement(&m);
    assert_eq!(reg.attested_measurement(), m, "the pinned measurement is read back");
}
