# zkLogin on Benzo (Stellar) — how the other chains do it, and how we do it

## How zkLogin works on other chains

**Sui zkLogin** and **Aptos Keyless** are the two production designs. Both turn an
ordinary OAuth/OIDC login (Google, Apple, …) into a self-custodial blockchain
account, with a zero-knowledge proof hiding the link between the Web2 identity and
the on-chain address. The flow (Sui's, Aptos is near-identical):

1. **Ephemeral key + nonce.** The wallet generates a short-lived key pair
   `(eph_sk, eph_pk)` and sets `nonce = H(eph_pk, max_epoch, randomness)` in the
   OAuth request. The signed JWT then *certifies* that ephemeral key.
2. **OIDC login → JWT.** Google returns a JWT, RS256-signed over
   `{ iss, aud, sub, nonce, … }`. `sub` is the stable per-user id; `aud` is the
   app's OAuth client id.
3. **Salt + address.** A `user_salt` (16 bytes) unlinks the identity from the
   address. The address is `H(sub, aud, iss, salt)` — stable per user, but nobody
   without the salt can link it to the Google account. Salt **option 4** is
   `HKDF(seed, iss‖aud, sub)` (self-custodial, no salt service).
4. **The ZK proof (Groth16 over BN254, Poseidon-BN254 hashing).** A proving
   service produces a proof that: the JWT's **RSA signature verifies** against the
   provider's JWK; the `nonce` commits to `eph_pk`; and the address is consistent
   with `sub + salt` — **without revealing the JWT or `sub`**.
5. **On-chain verification.** The chain verifies the Groth16 proof against the
   provider's JWKs (kept current by consensus) plus the ephemeral signature. The
   ephemeral key signs transactions for the session.

The expensive part is step 4: verifying an RSA-2048 signature *in-circuit* is
~millions of constraints (needs a large 2^20+ powers-of-tau and a hosted prover —
Mysten runs one for Sui). Everything else is cheap.

## Why this fits Benzo directly

Benzo's Soroban verifier already verifies **Groth16 over BN254** (CAP-0074) and
hashes with **Poseidon2** (CAP-0075) — the *same proof system* Sui zkLogin uses.
And `accountFromClaimSecret` is already the HKDF salt-derivation (option 4). So
zkLogin is not a new trust model for us — it is the JWT-RSA circuit plus the
address derivation we already have.

## What we built — Phase 1 (real Google, on-chain-derived account)

Code: `packages/core/src/zklogin.ts`, `apps/console-api/src/google-oidc.ts`,
the `/api/auth/*` routes, and the console sign-in (`apps/console/src/app/Onboarding.tsx`).

1. **Ephemeral nonce binding** — `zkLoginNonce(eph_pk, max_epoch, randomness)`
   (Poseidon2), exactly the Sui binding.
2. **Real Google OAuth** — when `GOOGLE_CLIENT_ID` is set, the console renders the
   real Google Identity Services button and receives a genuine Google **ID token**.
3. **Real JWT verification** — the BFF (`verifyGoogleIdToken`) checks the token's
   **RS256 signature against Google's live JWKs** with Node's built-in crypto
   (no added dependency), plus `iss` / `aud` / `exp` / `nonce`.
4. **Account derivation** — `accountFromOidc({ sub, iss, aud })` derives the Benzo
   spend/MVK/view keys via `HKDF` (salt option 4). The on-chain identity is a hash
   of the derived keys, so **`sub` never reaches the chain** (unlinkability), and
   the same Google account always recovers the same Benzo account.

What Phase 1 trades vs. full zkLogin: the JWT's RSA signature is verified **on the
BFF (off-chain)**, not in-circuit — so for the JWT step the chain trusts the BFF.
Everything else (derivation, unlinkability, nonce binding) is the real model.

## Phase 2 — fully trustless (the in-circuit JWT proof)

Move step 3's RSA verification **in-circuit** so the chain verifies the proof
against Google's JWKs directly (no BFF trust). Concretely:

- A `zklogin_jwt` Circom circuit (BN254): RSA-2048 verify of the JWT signature,
  JSON field extraction (`sub`, `aud`, `iss`, `nonce`), the nonce-binding check,
  and `addr_seed = Poseidon2(H(sub), H(aud), salt)` — public outputs `addr_seed`,
  `iss`, the JWK id, and `eph_pk`. (`oidcAddressSeed` already computes the seed
  off-circuit so the witness/derivation match.)
- This needs a **2^20+ powers-of-tau** and a hosted prover (RSA dominates the
  ~millions of constraints) — the same operational cost Sui's prover carries. It
  reuses Benzo's existing **proof artifact pipeline** (`scripts/build-artifacts.sh`)
  and the **TEE-attested ceremony** (`scripts/tee-ceremony.mjs`) for the phase-2
  key, and registers the VK on the existing verifier (`set_vk JWTLOGIN`) — no new
  on-chain code, because the verifier already does Groth16/BN254.
- Publish Google's JWKs on-chain (or pin a measurement) so the verifier can check
  the proof against the right key set, the way Sui's validators do by consensus.

## Enabling real Google (Phase 1) — setup

1. Create an OAuth **Web** client in Google Cloud Console → Credentials. Add your
   origins to *Authorized JavaScript origins* (e.g. `http://localhost:5174` and
   your deployed console origin).
2. Set `GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com` in the
   console-api environment (`.env`). Restart the BFF.
3. The console reads `GET /api/auth/config`; with a client id present it shows the
   real Google button, verifies the token via `POST /api/auth/google`, and signs
   you in. With no client id it shows a clearly-labeled demo sign-in.

No secret is needed for ID-token verification (the client id is public; Google's
JWKs are public), so `.env.example` can ship `GOOGLE_CLIENT_ID=` as a safe blank.

## References
- Sui zkLogin: https://docs.sui.io/concepts/cryptography/zklogin
- zkLogin paper (Baldimtsi et al.): https://arxiv.org/pdf/2401.11735
- Aptos Keyless: https://aptos.dev/en/build/guides/aptos-keyless
