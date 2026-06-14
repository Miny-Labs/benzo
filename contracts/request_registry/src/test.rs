#![allow(clippy::expect_used)] // tests may .expect() on known-good fixtures
use super::*;
use benzo_nullifier_set::{BenzoNullifierSet, BenzoNullifierSetClient};
use soroban_sdk::{
    Address, Env, U256,
    testutils::{Address as _, Ledger},
};

fn u(env: &Env, v: u32) -> U256 {
    U256::from_u32(env, v)
}

struct H {
    env: Env,
    payee: Address,
    ns: BenzoNullifierSetClient<'static>,
    reg: BenzoRequestRegistryClient<'static>,
}

fn setup() -> H {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);

    let ns_id = env.register(BenzoNullifierSet, (admin.clone(),));
    let ns = BenzoNullifierSetClient::new(&env, &ns_id);
    ns.set_operator(&operator);

    let reg_id = env.register(BenzoRequestRegistry, (admin, ns_id));
    let reg = BenzoRequestRegistryClient::new(&env, &reg_id);
    H { env, payee, ns, reg }
}

#[test]
fn register_opens_a_request() {
    let h = setup();
    let c = u(&h.env, 111);
    h.reg.register(&h.payee, &c, &25_000_000i128, &0i128, &100_000u64);
    let e = h.reg.get(&c).expect("request entry exists");
    assert_eq!(e.status, Status::Open);
    assert_eq!(e.paid_total, 0);
    assert_eq!(e.amount, 25_000_000);
}

#[test]
fn mark_paid_full_requires_a_real_spent_nullifier() {
    let h = setup();
    let c = u(&h.env, 1);
    h.reg.register(&h.payee, &c, &100i128, &0i128, &100_000u64);

    // unspent nullifier is rejected (no fabricated payments)
    let unspent = u(&h.env, 9);
    assert_eq!(
        h.reg.try_mark_paid(&c, &unspent, &100i128),
        Err(Ok(Error::PaymentNotFound))
    );

    // a real spent nullifier marks it paid
    let nf = u(&h.env, 7);
    h.ns.spend(&nf);
    assert_eq!(h.reg.mark_paid(&c, &nf, &100i128), Status::Paid);
    assert_eq!(h.reg.get(&c).expect("request entry exists").paid_total, 100);
}

#[test]
fn partial_then_full_with_no_double_count() {
    let h = setup();
    let c = u(&h.env, 3);
    h.reg.register(&h.payee, &c, &100i128, &20i128, &100_000u64);

    let n1 = u(&h.env, 11);
    h.ns.spend(&n1);
    assert_eq!(h.reg.mark_paid(&c, &n1, &40i128), Status::PartiallyPaid);

    // the same payment cannot be counted twice
    assert_eq!(
        h.reg.try_mark_paid(&c, &n1, &10i128),
        Err(Ok(Error::NullifierAlreadyUsed))
    );

    let n2 = u(&h.env, 12);
    h.ns.spend(&n2);
    assert_eq!(h.reg.mark_paid(&c, &n2, &60i128), Status::Paid);
    assert_eq!(h.reg.get(&c).expect("request entry exists").paid_total, 100);
}

#[test]
fn expire_is_permissionless_and_blocks_further_payment() {
    let h = setup();
    let c = u(&h.env, 4);
    h.reg.register(&h.payee, &c, &100i128, &0i128, &2_000u64);

    assert_eq!(h.reg.try_expire(&c), Err(Ok(Error::NotExpired)));
    h.env.ledger().set_timestamp(3_000);
    h.reg.expire(&c);
    assert_eq!(h.reg.get(&c).expect("request entry exists").status, Status::Expired);

    let nf = u(&h.env, 5);
    h.ns.spend(&nf);
    assert_eq!(
        h.reg.try_mark_paid(&c, &nf, &100i128),
        Err(Ok(Error::WrongStatus))
    );
}

#[test]
fn cancel_retains_entry_bad_expiry_and_variable_amount() {
    let h = setup();

    // cancel keeps the (now-Cancelled) entry
    let c = u(&h.env, 6);
    h.reg.register(&h.payee, &c, &100i128, &0i128, &100_000u64);
    h.reg.cancel(&c);
    assert_eq!(h.reg.get(&c).expect("request entry exists").status, Status::Cancelled);

    // expiry in the past is rejected
    let c2 = u(&h.env, 7);
    assert_eq!(
        h.reg.try_register(&h.payee, &c2, &100i128, &0i128, &500u64),
        Err(Ok(Error::BadExpiry))
    );

    // variable (amount 0) request never auto-completes
    let c3 = u(&h.env, 8);
    h.reg.register(&h.payee, &c3, &0i128, &0i128, &100_000u64);
    let nf = u(&h.env, 21);
    h.ns.spend(&nf);
    assert_eq!(h.reg.mark_paid(&c3, &nf, &5i128), Status::PartiallyPaid);
}

#[test]
fn duplicate_commitment_rejected() {
    let h = setup();
    let c = u(&h.env, 99);
    h.reg.register(&h.payee, &c, &10i128, &0i128, &100_000u64);
    assert_eq!(
        h.reg.try_register(&h.payee, &c, &10i128, &0i128, &100_000u64),
        Err(Ok(Error::AlreadyExists))
    );
}
