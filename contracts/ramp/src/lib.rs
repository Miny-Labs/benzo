#![no_std]

//! Benzo fiat ramp reserve — the on-chain analog of a Stellar anchor's
//! DISTRIBUTION ACCOUNT (the pattern MoneyGram Access uses for USDC cash-in /
//! cash-out on Stellar via SEP-24).
//!
//! What's real here, and what isn't:
//!   - REAL + on-chain: a USDC (SAC) reserve this contract holds. `cash_in`
//!     dispenses real USDC from the reserve to back a user's shield (the
//!     on-ramp / SEP-24 deposit); `cash_out` pulls real USDC from the user back
//!     into the reserve (the off-ramp / SEP-24 withdrawal). No custodial backend
//!     holds the funds — the contract is the reserve.
//!   - SIMULATED: only the *fiat* leg (charging a card / paying a bank). On
//!     testnet WE pre-fund the reserve and the admin authorizes `cash_in`,
//!     standing in for the anchor confirming "fiat received". There is no real
//!     money-transmission here — that requires a licensed anchor.
//!
//! INTEGRATION SEAM (credit: MoneyGram Access on Stellar —
//! developers.stellar.org/docs/tools/ramps/moneygram). To go live, the admin-
//! authorized `cash_in`/`cash_out` is replaced by the real SEP-24 interactive
//! flow against MoneyGram's distribution account: SEP-10 auth → SEP-24
//! deposit/withdraw → MoneyGram webview (SEP-9/12 KYC) → poll
//! `pending_user_transfer_start` → the distribution account sends/receives USDC
//! with a per-tx memo. Our `ref` field is exactly that memo, and our limits
//! mirror MoneyGram's published caps, so the swap is a drop-in.

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient, Address, BytesN, Env};

// MoneyGram Access published per-transaction caps (USDC has 7 decimals on Stellar).
const MIN: i128 = 5 * 10_000_000; //     5 USDC
const MAX_ON: i128 = 950 * 10_000_000; // 950 USDC (on-ramp / deposit)
const MAX_OFF: i128 = 2_500 * 10_000_000; // 2,500 USDC (off-ramp / withdrawal)

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotAdmin = 1,
    Paused = 2,
    InvalidAmount = 3,
    BelowMin = 4,
    AboveMax = 5,
    DuplicateRef = 6,
    InsufficientReserve = 7,
}

#[contracttype]
enum DataKey {
    Admin,
    Usdc,
    Paused,
    TotalIn,
    TotalOut,
    Ref(BytesN<32>),
}

#[contractevent(topics = ["cash_in"])]
pub struct CashIn {
    pub to: Address,
    pub amount: i128,
    pub reference: BytesN<32>,
}

#[contractevent(topics = ["cash_out"])]
pub struct CashOut {
    pub from: Address,
    pub amount: i128,
    pub reference: BytesN<32>,
}

#[contract]
pub struct RampContract;

#[contractimpl]
impl RampContract {
    /// `admin` authorizes cash-ins (stands in for the anchor's fiat-confirm);
    /// `usdc` is the USDC SAC the reserve holds.
    pub fn __constructor(env: Env, admin: Address, usdc: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::TotalIn, &0i128);
        env.storage().instance().set(&DataKey::TotalOut, &0i128);
    }

    /// Top up the reserve (we pre-fund it on testnet). Pulls `amount` USDC from
    /// `from` into the contract. Anyone may fund.
    pub fn fund(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        TokenClient::new(&env, &Self::usdc(&env)).transfer(&from, &env.current_contract_address(), &amount);
        Ok(())
    }

    /// ON-RAMP (SEP-24 deposit): dispense `amount` USDC from the reserve to `to`,
    /// to back the user's shield. Admin-authorized (the operator confirms the
    /// simulated fiat leg). `reference` is the per-tx memo — replayed cash-ins on
    /// the same reference are rejected (idempotent, like the anchor's memo).
    pub fn cash_in(env: Env, to: Address, amount: i128, reference: BytesN<32>) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        Self::guard(&env, amount, MAX_ON, &reference)?;
        let usdc = Self::usdc(&env);
        let bal = TokenClient::new(&env, &usdc).balance(&env.current_contract_address());
        if bal < amount {
            return Err(Error::InsufficientReserve);
        }
        TokenClient::new(&env, &usdc).transfer(&env.current_contract_address(), &to, &amount);
        Self::mark(&env, reference.clone());
        let total: i128 = env.storage().instance().get(&DataKey::TotalIn).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalIn, &(total + amount));
        CashIn { to, amount, reference }.publish(&env);
        Ok(())
    }

    /// OFF-RAMP (SEP-24 withdrawal): pull `amount` USDC from `from` (the user,
    /// after unshield) into the reserve. The user authorizes the transfer to the
    /// anchor's account; the simulated fiat payout happens off-chain.
    pub fn cash_out(env: Env, from: Address, amount: i128, reference: BytesN<32>) -> Result<(), Error> {
        from.require_auth();
        Self::guard(&env, amount, MAX_OFF, &reference)?;
        TokenClient::new(&env, &Self::usdc(&env)).transfer(&from, &env.current_contract_address(), &amount);
        Self::mark(&env, reference.clone());
        let total: i128 = env.storage().instance().get(&DataKey::TotalOut).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalOut, &(total + amount));
        CashOut { from, amount, reference }.publish(&env);
        Ok(())
    }

    /// The live USDC reserve balance — readable by anyone (blockchain is the backend).
    pub fn reserve(env: Env) -> i128 {
        TokenClient::new(&env, &Self::usdc(&env)).balance(&env.current_contract_address())
    }

    /// (total_in, total_out, reserve).
    pub fn stats(env: Env) -> (i128, i128, i128) {
        (
            env.storage().instance().get(&DataKey::TotalIn).unwrap_or(0),
            env.storage().instance().get(&DataKey::TotalOut).unwrap_or(0),
            Self::reserve(env.clone()),
        )
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    // ---- internals ----
    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }
    fn usdc(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Usdc).unwrap()
    }
    fn guard(env: &Env, amount: i128, max: i128, reference: &BytesN<32>) -> Result<(), Error> {
        if env.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount < MIN {
            return Err(Error::BelowMin);
        }
        if amount > max {
            return Err(Error::AboveMax);
        }
        if env.storage().persistent().has(&DataKey::Ref(reference.clone())) {
            return Err(Error::DuplicateRef);
        }
        Ok(())
    }
    fn mark(env: &Env, reference: BytesN<32>) {
        env.storage().persistent().set(&DataKey::Ref(reference), &true);
    }
}

#[cfg(test)]
mod test;
