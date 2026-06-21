#![no_std]

//! Benzo time-locked escrow — the on-chain primitive behind claim-links (paying
//! someone who isn't on Benzo yet) with a RECIPIENT-protecting time-lock.
//!
//! The old claim flow funded an ephemeral account the SENDER also controlled, so
//! the sender could sweep the funds back at any moment — an off-chain "don't
//! refund yet" check would be theater (the sender holds the key). This contract
//! moves custody on-chain: funds live in the contract, the `claimant` may claim
//! at ANY time, and the `from` may only `refund` at/after `unlock_at`. That gives
//! the recipient a guaranteed claim window the sender cannot rug.
//!
//! Funds are held as a Stellar asset (USDC SAC); the contract never mints.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token::TokenClient, Address, BytesN, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NotFound = 2,
    AlreadySettled = 3,
    LockNotExpired = 4,
    InvalidAmount = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Status {
    Pending,
    Claimed,
    Refunded,
}

#[contracttype]
#[derive(Clone)]
pub struct Escrow {
    pub from: Address,
    pub claimant: Address,
    pub token: Address,
    pub amount: i128,
    /// unix seconds; `from` may refund only at/after this (the recipient's window)
    pub unlock_at: u64,
    pub status: Status,
}

#[contracttype]
enum DataKey {
    E(BytesN<32>),
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Lock `amount` of `token` for `claimant`, refundable to `from` only at/after
    /// `unlock_at`. Pulls the funds from `from` into the contract.
    pub fn create(
        env: Env,
        id: BytesN<32>,
        from: Address,
        claimant: Address,
        token: Address,
        amount: i128,
        unlock_at: u64,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::E(id);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        env.storage().persistent().set(
            &key,
            &Escrow { from, claimant, token, amount, unlock_at, status: Status::Pending },
        );
        Ok(())
    }

    /// The claimant pulls the escrowed funds — allowed at any time.
    pub fn claim(env: Env, id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::E(id);
        let mut e: Escrow = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
        if e.status != Status::Pending {
            return Err(Error::AlreadySettled);
        }
        e.claimant.require_auth();
        TokenClient::new(&env, &e.token).transfer(&env.current_contract_address(), &e.claimant, &e.amount);
        e.status = Status::Claimed;
        env.storage().persistent().set(&key, &e);
        Ok(())
    }

    /// The sender reclaims — ONLY at/after `unlock_at` (the time-lock), and only
    /// if still unclaimed.
    pub fn refund(env: Env, id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::E(id);
        let mut e: Escrow = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
        if e.status != Status::Pending {
            return Err(Error::AlreadySettled);
        }
        e.from.require_auth();
        if env.ledger().timestamp() < e.unlock_at {
            return Err(Error::LockNotExpired);
        }
        TokenClient::new(&env, &e.token).transfer(&env.current_contract_address(), &e.from, &e.amount);
        e.status = Status::Refunded;
        env.storage().persistent().set(&key, &e);
        Ok(())
    }

    pub fn get(env: Env, id: BytesN<32>) -> Option<Escrow> {
        env.storage().persistent().get(&DataKey::E(id))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token::StellarAssetClient,
        Address, BytesN, Env,
    };

    fn setup() -> (Env, EscrowContractClient<'static>, Address, Address, Address, TokenClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = TokenClient::new(&env, &sac.address());
        let token_admin = StellarAssetClient::new(&env, &sac.address());
        let from = Address::generate(&env);
        let claimant = Address::generate(&env);
        token_admin.mint(&from, &1_000);
        (env, client, from, claimant, sac.address(), token)
    }

    #[test]
    fn claim_before_unlock_pays_recipient() {
        let (env, client, from, claimant, token, tc) = setup();
        let id = BytesN::from_array(&env, &[1u8; 32]);
        client.create(&id, &from, &claimant, &token, &600, &(env.ledger().timestamp() + 3600));
        assert_eq!(tc.balance(&from), 400);
        assert_eq!(tc.balance(&client.address), 600);
        client.claim(&id); // recipient claims any time
        assert_eq!(tc.balance(&claimant), 600);
        assert_eq!(client.get(&id).unwrap().status, Status::Claimed);
    }

    #[test]
    fn refund_blocked_until_unlock_then_allowed() {
        let (env, client, from, claimant, token, tc) = setup();
        let id = BytesN::from_array(&env, &[2u8; 32]);
        let unlock = env.ledger().timestamp() + 3600;
        client.create(&id, &from, &claimant, &token, &600, &unlock);
        // before unlock: refund must fail (recipient's guaranteed window)
        assert_eq!(client.try_refund(&id), Err(Ok(Error::LockNotExpired)));
        // after unlock: sender can reclaim
        env.ledger().set_timestamp(unlock + 1);
        client.refund(&id);
        assert_eq!(tc.balance(&from), 1_000);
        assert_eq!(client.get(&id).unwrap().status, Status::Refunded);
    }

    #[test]
    fn cannot_double_settle() {
        let (env, client, from, claimant, token, _tc) = setup();
        let id = BytesN::from_array(&env, &[3u8; 32]);
        client.create(&id, &from, &claimant, &token, &100, &0);
        client.claim(&id);
        assert_eq!(client.try_claim(&id), Err(Ok(Error::AlreadySettled)));
        assert_eq!(client.try_refund(&id), Err(Ok(Error::AlreadySettled)));
    }
}
