use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, BytesN, Env};

const USDC: i128 = 10_000_000; // 1 USDC in stroops

fn setup() -> (Env, RampContractClient<'static>, Address, Address, TokenClient<'static>, StellarAssetClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let mint = StellarAssetClient::new(&env, &sac.address());
    let cid = env.register(RampContract, (admin.clone(), sac.address()));
    let client = RampContractClient::new(&env, &cid);
    (env, client, admin, sac.address(), token, mint)
}

fn r(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn fund_then_cash_in_dispenses_real_usdc() {
    let (env, client, _admin, _usdc, token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(1_000 * USDC));

    client.fund(&funder, &(1_000 * USDC));
    assert_eq!(client.reserve(), 1_000 * USDC);

    // on-ramp: dispense 100 USDC from the reserve to the user (backs their shield)
    client.cash_in(&user, &(100 * USDC), &r(&env, 1));
    assert_eq!(token.balance(&user), 100 * USDC);
    assert_eq!(client.reserve(), 900 * USDC);
    assert_eq!(client.stats(), (100 * USDC, 0, 900 * USDC));
}

#[test]
fn cash_out_absorbs_usdc_into_reserve() {
    let (env, client, _admin, _usdc, token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(1_000 * USDC));
    mint.mint(&user, &(100 * USDC)); // user holds USDC post-unshield
    client.fund(&funder, &(1_000 * USDC));

    // off-ramp: pull 40 USDC from the user back into the reserve
    client.cash_out(&user, &(40 * USDC), &r(&env, 2));
    assert_eq!(token.balance(&user), 60 * USDC);
    assert_eq!(client.reserve(), 1_040 * USDC);
    assert_eq!(client.stats(), (0, 40 * USDC, 1_040 * USDC));
}

#[test]
fn round_trip_is_reserve_neutral() {
    let (env, client, _admin, _usdc, _token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(1_000 * USDC));
    client.fund(&funder, &(1_000 * USDC));
    client.cash_in(&user, &(100 * USDC), &r(&env, 1)); // reserve 900
    client.cash_out(&user, &(100 * USDC), &r(&env, 2)); // reserve back to 1000
    assert_eq!(client.reserve(), 1_000 * USDC);
}

#[test]
fn enforces_moneygram_limits() {
    let (env, client, _admin, _usdc, _token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(5_000 * USDC));
    mint.mint(&user, &(5_000 * USDC));
    client.fund(&funder, &(5_000 * USDC));

    // below 5 USDC min
    assert_eq!(client.try_cash_in(&user, &(4 * USDC), &r(&env, 1)), Err(Ok(Error::BelowMin)));
    // on-ramp max is 950 USDC
    assert_eq!(client.try_cash_in(&user, &(951 * USDC), &r(&env, 2)), Err(Ok(Error::AboveMax)));
    // off-ramp max is 2,500 USDC — 1,000 is fine, 2,501 is not
    client.cash_out(&user, &(1_000 * USDC), &r(&env, 3));
    assert_eq!(client.try_cash_out(&user, &(2_501 * USDC), &r(&env, 4)), Err(Ok(Error::AboveMax)));
}

#[test]
fn rejects_duplicate_reference() {
    let (env, client, _admin, _usdc, _token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(1_000 * USDC));
    client.fund(&funder, &(1_000 * USDC));
    client.cash_in(&user, &(50 * USDC), &r(&env, 7));
    // same per-tx memo/reference can't be replayed
    assert_eq!(client.try_cash_in(&user, &(50 * USDC), &r(&env, 7)), Err(Ok(Error::DuplicateRef)));
}

#[test]
fn rejects_cash_in_above_reserve() {
    let (env, client, _admin, _usdc, _token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(100 * USDC));
    client.fund(&funder, &(100 * USDC));
    // within the 950 on-ramp max, but above the 100-USDC reserve:
    assert_eq!(client.try_cash_in(&user, &(101 * USDC), &r(&env, 2)), Err(Ok(Error::InsufficientReserve)));
}

#[test]
fn paused_blocks_both_directions() {
    let (env, client, _admin, _usdc, _token, mint) = setup();
    let funder = Address::generate(&env);
    let user = Address::generate(&env);
    mint.mint(&funder, &(1_000 * USDC));
    mint.mint(&user, &(100 * USDC));
    client.fund(&funder, &(1_000 * USDC));
    client.set_paused(&true);
    assert_eq!(client.try_cash_in(&user, &(50 * USDC), &r(&env, 1)), Err(Ok(Error::Paused)));
    assert_eq!(client.try_cash_out(&user, &(50 * USDC), &r(&env, 2)), Err(Ok(Error::Paused)));
    client.set_paused(&false);
    client.cash_in(&user, &(50 * USDC), &r(&env, 1)); // works again
}
