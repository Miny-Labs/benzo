
use super::*;
use soroban_sdk::{Address, Env, U256, Vec, testutils::Address as _, vec};

fn setup() -> (Env, BenzoOrgAccountClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(BenzoOrgAccount, (admin,));
    let client = BenzoOrgAccountClient::new(&env, &contract_id);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    (env, client, a, b, c)
}

fn members(env: &Env, a: &Address, b: &Address, c: &Address) -> Vec<Address> {
    vec![env, a.clone(), b.clone(), c.clone()]
}

#[test]
fn register_and_read_org() {
    let (env, client, a, b, c) = setup();
    let gk = U256::from_u32(&env, 999);
    client.register_org(&1u64, &gk, &2u32, &members(&env, &a, &b, &c));
    let org = client.get_org(&1u64);
    assert_eq!(org.threshold, 2);
    assert_eq!(org.epoch, 0);
    assert_eq!(org.members.len(), 3);
    assert_eq!(org.group_pubkey, gk);
}

#[test]
fn member_root_round_trips_for_in_circuit_m_of_n() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));
    // an off-chain-computed (circomlib-Poseidon) root of members' BabyJubJub key-ids
    let root = U256::from_u32(&env, 0xdead_beef);
    client.set_member_root(&1u64, &root);
    assert_eq!(client.member_root(&1u64), root);
    assert!(client.try_member_root(&2u64).is_err()); // unset for an unknown org
    assert!(client.try_set_member_root(&9u64, &root).is_err()); // can't set for a non-existent org
}

#[test]
fn dual_control_reaches_threshold_with_distinct_members() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));

    // a proposes.
    client.propose(&1u64, &7u64, &U256::from_u32(&env, 0xabc), &a);
    assert_eq!(client.approval_count(&1u64, &7u64), 0);
    assert!(!client.is_approved(&1u64, &7u64));

    // b approves -> 1, not yet approved.
    assert_eq!(client.approve(&1u64, &7u64, &b), 1);
    assert!(!client.is_approved(&1u64, &7u64));

    // c approves -> 2 distinct, threshold met.
    assert_eq!(client.approve(&1u64, &7u64, &c), 2);
    assert!(client.is_approved(&1u64, &7u64));
}

#[test]
fn proposer_cannot_approve_own_proposal() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));
    client.propose(&1u64, &7u64, &U256::from_u32(&env, 1), &a);
    // Segregation of duties: the proposer (a) cannot approve.
    assert!(client.try_approve(&1u64, &7u64, &a).is_err());
}

#[test]
fn duplicate_approval_is_rejected() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));
    client.propose(&1u64, &7u64, &U256::from_u32(&env, 1), &a);
    client.approve(&1u64, &7u64, &b);
    // b cannot approve twice (the count must reflect DISTINCT members).
    assert!(client.try_approve(&1u64, &7u64, &b).is_err());
    assert_eq!(client.approval_count(&1u64, &7u64), 1);
}

#[test]
fn non_member_cannot_propose_or_approve() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));
    let outsider = Address::generate(&env);
    assert!(client.try_propose(&1u64, &7u64, &U256::from_u32(&env, 1), &outsider).is_err());
    client.propose(&1u64, &8u64, &U256::from_u32(&env, 1), &a);
    assert!(client.try_approve(&1u64, &8u64, &outsider).is_err());
}

#[test]
fn rejects_bad_threshold() {
    let (env, client, a, b, c) = setup();
    let m = members(&env, &a, &b, &c);
    // threshold 0 and threshold > members are both invalid.
    assert!(client.try_register_org(&1u64, &U256::from_u32(&env, 1), &0u32, &m).is_err());
    assert!(client.try_register_org(&2u64, &U256::from_u32(&env, 1), &4u32, &m).is_err());
}

#[test]
fn kyb_attestation_is_on_chain_and_issuer_gated() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));

    // default: Unverified, no backend decided anything
    assert_eq!(client.kyb_status(&1u64).0, KybStatus::Unverified);

    // designate an on-chain KYB issuer (the seam for a real provider's key)
    let issuer = Address::generate(&env);
    client.set_kyb_issuer(&issuer);

    // the issuer posts an Approved attestation on-chain (signed, not fabricated)
    client.attest_kyb(&1u64, &KybStatus::Approved, &U256::from_u32(&env, 0xABC));
    let (status, inquiry) = client.kyb_status(&1u64);
    assert_eq!(status, KybStatus::Approved);
    assert_eq!(inquiry, U256::from_u32(&env, 0xABC));
}

#[test]
fn kyb_attest_requires_an_issuer_to_be_set() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));
    // no issuer designated yet -> cannot attest
    assert!(client.try_attest_kyb(&1u64, &KybStatus::Approved, &U256::from_u32(&env, 1)).is_err());
}

#[test]
fn kyb_attest_unknown_org_fails() {
    let (env, client, _a, _b, _c) = setup();
    let issuer = Address::generate(&env);
    client.set_kyb_issuer(&issuer);
    assert!(client.try_attest_kyb(&9u64, &KybStatus::Approved, &U256::from_u32(&env, 1)).is_err());
}

#[test]
fn rotate_bumps_epoch_for_offboarding() {
    let (env, client, a, b, c) = setup();
    client.register_org(&1u64, &U256::from_u32(&env, 1), &2u32, &members(&env, &a, &b, &c));
    // Offboard c: rotate to [a, b], threshold 2, new key.
    client.rotate(&1u64, &U256::from_u32(&env, 2), &2u32, &vec![&env, a.clone(), b.clone()]);
    let org = client.get_org(&1u64);
    assert_eq!(org.epoch, 1);
    assert_eq!(org.members.len(), 2);
    assert_eq!(org.group_pubkey, U256::from_u32(&env, 2));
}
