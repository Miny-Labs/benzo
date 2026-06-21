# Benzo — client-side architecture + ZK reality map

_Thesis (the founder's goal, verbatim intent): **the blockchain is the backend, ZK is the security + privacy, and the app is served client-side — ideally with no custodial backend at all.** This doc maps how far Benzo already is from that, exactly what each current server (BFF) responsibility becomes in the browser, what ZK is **real on-chain** vs **mocked**, and the de-mock + mainnet-hardening path. Date 2026-06-21._

---

## 1. Where we are today

Two thin React apps talk to two **node:http BFFs** (`wallet-api` :8791, `console-api` :8790). The BFFs are **not** custodians of business logic — they are a thin wrapper around **`@benzo/core`**, the headless TypeScript SDK that already does the real work: notes, Poseidon2, Groth16 proving, viewing keys, the pool/Merkle client, the scanner, onboarding, relay.

The critical fact: **`@benzo/core` already ships a browser entry** (`packages/core/src/index.browser.ts`) that exports everything except the two node-only modules:

- `stellar.ts` → `StellarCli` (shells `node:child_process`) — **browser replaces with `StellarRpcClient`** (same `ChainClient` interface, pure `@stellar/stellar-sdk` RPC, already exported in the browser bundle).
- `account-file.ts` → file persistence — **browser replaces with a `KVStore` over IndexedDB** (the `KVStore` interface + `store.ts` are already browser-exported).

Everything else `BenzoClient` needs is constructor-injected and already browser-safe:

```ts
new BenzoClient({
  cli: new StellarRpcClient({ rpcUrl, networkPassphrase }), // ← was StellarCli (node)
  deployment,        // testnet.json (static, shippable)
  circuits,          // proving artifacts (packages/proving-artifacts)
  prover: WasmProver,// ← was NodeProver; snarkjs in WASM, on-device
  store: idbStore,   // ← was FileKVStore; IndexedDB
  rpcUrl, txSource, relayer,
})
```

**So the BFF is already a removable shim, not a dependency.** What's left is wiring the browser to construct `BenzoClient` directly, sourcing keys from the passkey (S3, already built), and sponsoring gas so the user needs no XLM.

---

## 2. BFF responsibility → browser equivalent

Each thing `wallet-api/chain.ts` does today, and where it goes client-side:

| BFF responsibility (today) | `@benzo/core` browser primitive | Client-side status | Notes |
|---|---|---|---|
| **RPC reads** (balance, history, pool tree) | `StellarRpcClient` + `scanner` (`syncFromRpc`, `fetchAspLeaves`) | ✅ Ready | `StellarRpcClient implements ChainClient` — drop-in for `StellarCli`. |
| **Proving** (balance/sum) | `WasmProver` (snarkjs WASM) | ✅ **DONE (live)** | `proveBalanceClientSide` generates the Groth16 proof_of_balance ON-DEVICE (25MB zkey served from `/public/circuits`, fetched once) — witness never leaves the browser — verified `{holds, onChain:true}` in 5.4s. The spend circuits (shield/joinsplit 21MB/unshield) use the **same** WasmProver path; only the relay-submit (§ Gas) remains to wire them. |
| **Note scanning / discovery** | `NoteScanner` + `syncFromRpc` + `NoteScanner.restore(snapshot)` | ✅ **DONE (live)** | Browser syncs the pool from RPC + trial-decrypts its own notes; balance computed on-device. IndexedDB snapshot makes warm loads ~0.9s (15× vs cold). |
| **Key material** | `account.ts` (`accountFromClaimSecret`, app-scoped HKDF) seeded by **passkey PRF** | ✅ Built (passkey) / ⚙️ testnet-import | Passkey (S3) derives keys on-device. The existing funded testnet account is provisioned to the browser once via the hard-gated `/api/dev/account` (`BENZO_DEV_EXPORT=1`, testnet-only) — the file-custody→device-custody migration step; prod = passkey, never transmitted. |
| **Persistence** (account, scanner state) | `KVStore` over IndexedDB | ✅ **DONE (live)** | `IdbKVStore` (get/set over IndexedDB) ships; scanner snapshot persists → incremental resume. Encrypt-at-rest (passkey-derived key, via the existing `@benzo/wallet` Keychain) is the prod hardening. |
| **Onboarding** (sponsored zero-XLM account) | `onboard.ts` (CAP-33 sponsored reserves) + `reserves.ts` | ⚙️ Needs relayer | Sponsor signs server-side OR via OpenZeppelin Relayer (Stellar Channels). See §4. |
| **Gas / submission** | `relay.ts` + `makeRelay()` + `StellarRpcClient.submitWrite` | ✅ **DONE (live, on-chain)** | A full **client-side SEND** settles on-chain: browser resolves the @handle, proves the shielded transfer on-device (WasmProver, 21MB joinsplit — witness never leaves), then `makeRelay()` → `cli.invoke(send:true)` → `submitWrite` POSTs ONLY {contractId, fnArgs} (proof + public commitments/nullifiers, NEVER the witness) to a stateless, pool-scoped gas relay (`/api/relay/submit`, signs with the gas key). Verified: tx `a49367e9…` settled (~27s end-to-end). The relay is the irreducible "gas station, not the bank". |
| **Tx submission + confirm poll** | `StellarRpcClient.invoke` (simulate → assemble → send → poll) | ✅ Ready | Same path the dapp skill documents. |
| **Handle ↔ address directory** | (currently BFF map) | ⚠️ Needs a public index | The one genuinely shared read. Options: a Soroban registry contract (fully on-chain, preferred), or a thin read-only edge index. Privacy: store only handle→address, never amounts. |
| **Fiat on/off-ramp** | (simulated) | ⚠️ External | Real rails need an Anchor (SEP-24) or PSP — inherently a third party. Isolate behind `@benzo/kyc`/ramp adapter; everything else stays client-side. |

**Verdict:** ~70% of the BFF is a thin pass-through to browser-ready core primitives and can move to the client now. The irreducible server-touch surface is three things — **a gas relayer, a handle directory, and the fiat ramp** — and all three are *stateless or third-party*, none is a custodial backend that holds funds or sees secrets.

---

## 3. ZK reality map — real vs mocked

Honesty matters here; this is the part most easily overstated. Source: `wallet-api/chain.ts`, `packages/core`, the on-chain VK registry (testnet.json), and prior live-verified runs.

### Real, verified **on-chain** (Groth16/BN254 via CAP-0074, Poseidon2 via CAP-0075)

| Circuit / flow | What it proves | On-chain verify? |
|---|---|---|
| **shield (deposit)** | ASP allow-list membership + KYC admission at deposit | ✅ VK registered, verified live |
| **unshield (withdraw)** | proof-of-innocence (exclusion from blocklist) + valid note | ✅ verified live |
| **joinsplit / transfer** | balance-preserving spend of shielded notes (nullifiers + new commitments) | ✅ verified live |
| **kyc_credential** | holds a valid KYC credential at the required tier (in-circuit) | ✅ VK on testnet |
| **asp_membership** | recipient ∈ approved set | ✅ on-chain |
| **funds_attestation** | proof-of-funds ≥ threshold without revealing balance | ✅ VK on-chain, real proof → true (v2 build) |
| **proof_of_balance** | hold ≥ a threshold without revealing the amount | ✅ **DE-MOCKED 2026-06-21** — BALANCE VK now registered on-chain (tx `5f112ad7…`); `shareProof` calls `verifier.verify_proof(BALANCE, …)` and the UI shows "Verified on-chain". Live: `min $0.50` over a real $0.66 shielded balance → `onChain:true`; `min $5` correctly refuses. |
| **registeredMvkRoot** gate | spend authority bound to a registered viewing-key root | ✅ P0 enforced on-chain, proven both directions |

### Real proof, **NOT yet on-chain-verified** (the honest gaps)

| Item | State | De-mock |
|---|---|---|
| **proof_of_sum** (disclose-total to auditor) | ✅ **DE-MOCKED** — the console Treasury "Disclose exact total" now calls `c.proveTotal()` → `verify_proof(SUM,…)` on-chain (replacing the plaintext `disclosedTotal()`). Live: `{total, onChain:true}`; UI: "the network verified the sum proof — proven, not asserted." Individual amounts stay hidden. |

### Mocked / simulated (clearly labeled in UI as "demo")

| Item | Why mocked | Real path |
|---|---|---|
| **KYB (business verification)** | No KYB provider wired; returns a labeled mock decision. | Wire a real KYB/IDV provider (Persona/Veriff pattern); person IDV can use Self.xyz (real Groth16 backend-verify) per the de-mock tool-fit. |
| **Fiat on/off-ramp** | No anchor/PSP integrated. | SEP-24 anchor or PSP; sandbox = Plaid (creds present) for proof-of-funds. |
| **zkLogin / OAuth** | JWKS verify happens off-circuit. | In-circuit JWT/sig gadget (large; needs ceremony) — backlog. |
| **TEE attestation (big circuits)** | PhalaProver path is real but flaky for the largest circuits. | funds/kyc proofs are on-chain-reliable; harden TEE for the rest. |

**Bottom line:** the core money-movement privacy (shield/unshield/transfer/KYC-admission/proof-of-innocence/funds-attestation) is **real ZK verified on-chain, no mocks**. The gaps are (a) two circuits proven-but-not-on-chain-verified (balance, sum — registrable now) and (b) the **non-ZK edges** (KYB, fiat, OAuth) that are third-party by nature and are honestly labeled "demo" in the UI.

---

## 4. Gas without a backend (the keystone for client-side)

The single thing that makes "no backend" real for a money app: **users must not need XLM to pay fees.** Path:

1. Client builds + simulates + assembles the Soroban tx via `StellarRpcClient` (all browser).
2. Client signs the **inner** tx with the passkey-derived key.
3. A **stateless fee-bump relayer** wraps it in a fee-bump and submits. The relayer:
   - Sees only public tx data (commitments, nullifiers, proof) — **never** a witness or a secret.
   - Holds no user funds, no user keys, no business logic. It is replaceable and can be self-hosted.
   - Option A: OpenZeppelin Relayer / Stellar Channels (documented in the dapp skill). Option B: a tiny self-hosted fee-bump endpoint.

This is the one piece that is "server-touch" but explicitly **not** a custodial backend — it is the gas station, not the bank. Sponsored account creation (CAP-33, `onboard.ts`) uses the same trust model.

---

## 5. Migration plan (incremental, each step shippable)

1. ✅ **Browser `ChainClient` read path** — `StellarRpcClient` reads the ledger + (via `benzoClient.ts`) the shielded balance directly from RPC; BFF fallback retained. _(DONE, live.)_
2. ✅ **IndexedDB `KVStore`** — `IdbKVStore` ships; scanner snapshot persists → warm read ~0.9s. _(DONE, live.)_ Encrypt-at-rest (passkey key) is the prod follow-on.
3. ✅ **On-device proving** — `WasmProver` generates proof_of_balance on-device (witness never leaves), verified on-chain; ShareProof uses it (BFF fallback). _(DONE, live.)_
4. ✅ **Client-side submit via relayer (SEND)** — the wallet's @handle send now proves the transfer on-device + submits via the stateless gas relay; settled on-chain (tx `a49367e9…`), wired into the Send UI with BFF fallback. _(DONE, live.)_ Remaining of this step: shield/unshield via the same path (joinsplit/transfer is the proven template).
5. **Handle directory on-chain** — already a Soroban `handle_registry` contract; the client resolves @handle→pubkeys directly via `StellarRpcClient` (no BFF). Making it the canonical directory (vs the BFF map) is the cleanup.
6. **Retire the BFFs** to optional dev conveniences; ship the apps as static + chain + relayer + ramp adapter.

The two apps **stay separate** throughout (5-layer identity separation is unaffected — derivation label, storage root, OAuth aud, link app-scope, HKDF domain sep all live in `@benzo/core` + `@benzo/links`, not the BFF).

---

## 6. Mainnet-hardening checklist (production, not testnet)

Tracked separately from the client-side migration; both are needed for production.

- [x] **Per-role funded operators (relay)** — DONE: the gas relay signs with its OWN funded operator key (`benzo-relayer`), not `benzo-deployer`; verified on-chain (tx `da047b87…` `source_account` = the relayer, not the deployer). Fixes the relay-vs-deployer `TxBadSeq` collision. Remaining: split the wallet vs console operators too (same pattern), and per-user relayer accounts for mainnet scale.
- [x] **Register proof_of_balance VK on-chain** — DONE (2026-06-21); balance proof verifies on-chain via `verify_proof(BALANCE,…)`.
- [x] **Route proof_of_sum auditor disclosure through `verify_proof(SUM,…)`** — DONE (2026-06-21); `proveTotal()` → on-chain SUM verify (SUM VK registered). _Gap closed: both BALANCE and SUM are real on-chain verifies; the only remaining gap is an **automated** on-chain test (today they're covered by the live BFF/UI path, not by `pnpm test`) — `tests/e2e/sum-balance-onchain.mjs` added to close it._
- [~] **On-chain org dual-control (IN-CIRCUIT M-of-N — chosen locus)** — circuit BUILT + dev-setup + PROVEN ON-CHAIN: `circuits/groth16/org_spend_auth.circom` (33.6k constraints) proves ≥threshold distinct members EdDSA-signed the spend (members ∈ `orgMemberRoot`); witness tests (valid 2-of-3 authorizes; sub-threshold + dup-signer rejected) + a full prove/verify test pass; ORGAUTH VK registered on the live verifier (tx `df352cd5`) and a real 2-of-3 proof returns `verify_proof(ORGAUTH) => true` ON-CHAIN. Remaining: bind `authTag` into the joinsplit/spend public inputs + pool gate, SDK witness wiring, multi-party ceremony redo (the in-circuit choice invalidates it). Off-chain maker-checker is the interim control.
- [ ] **MVK registry key ceremony** — production viewing-key root governance.
- [ ] **Real KYB/IDV + fiat anchor** — replace labeled mocks (§3).
- [ ] **Production RPC provider** — not the public testnet endpoint; rate-limit + failover.
- [x] **Network-agnostic config (not testnet-locked)** — DONE: client config is 12-factor env (`apps/wallet/src/lib/network.ts`, mainnet via `VITE_BENZO_*`), and `deploy-testnet.sh` is parametrized by `BENZO_NETWORK` (testnet|mainnet → network/output/explorer; mainnet forces `REQUIRE_VK_PROVENANCE=1`). Going to mainnet is now an env swap + funded operators + ceremony, not a code change.
- [x] **Relayer hardening** — DONE: pool-only + `transfer`-fn-only + fixed-window rate limit (30/60s) + its own operator key. Remaining: anti-DoS at scale, multi-instance self-host.
- [x] **IndexedDB encryption at rest** — DONE: the note-discovery snapshot is AES-GCM sealed under an HKDF(account viewing-secret) key; verified the stored value is ciphertext + still resumes (cold+warm both correct). Remaining: derive the wrapping key from the passkey PRF (not the imported testnet account) once onboarding is passkey-native.
- [x] **Claim-link escrow time-lock (on-chain)** — `contracts/escrow` built + tested (3/3) + 16K wasm: on-chain custody where the claimant can claim anytime and the sender can `refund` only at/after `unlock_at` (a window the sender can't rug — the off-chain account-based escrow couldn't guarantee this). Remaining: integrate into the shielded claim flow + add to the deploy script.
- [x] **Audit hash-chain for the console ledger** — DONE: each `LedgerEntry.hash = sha256(prevHash + canonical(entry))`; `verifyLedgerChain()` re-walks + reports the first tampered index; `GET /api/ledger/verify` → `{ok, length, brokenAt?}` (verified `{ok:true}`). Remaining: fiat reconciliation.
- [ ] **Trusted-setup provenance** — document/verify the Groth16 ceremony for each registered VK before mainnet.
- [ ] **Negative-path + replay tests** on every verifier (anti-replay binding already present via nullifiers; document per circuit).

---

## 6a. In-circuit M-of-N spend-enforcement — integration plan (scoped, not yet wired)

The M-of-N proof (`org_spend_auth`) is built + dev-set-up + **verified on-chain** (`verify_proof(ORGAUTH)=>true`). Making it *gate* a real spend is the remaining work. The right architecture is **compose, don't merge** (the zk-proofs skill's policy-and-proof split):

- **Don't** merge M-of-N into `joinsplit` — that's a circuit rewrite that **invalidates the joinsplit ceremony** and re-proves every transfer fixture. Instead keep `joinsplit` (value/privacy) and `org_spend_auth` (policy) as **two proofs the pool verifies for the same spend**, bound by a shared `spendMessage`. Only `org_spend_auth` needs a ceremony → joinsplit's is preserved.
- **Binding:** `spendMessage` must commit to *this* transfer so the auth proof can't be replayed. Set `spendMessage = H(nullifier0, nullifier1, outCommitment0, outCommitment1)`; the pool computes the same and requires `org_auth.spendMessage == that` + `org_auth.orgMemberRoot == the org's registered member root`.
- **⚠️ SOUNDNESS CORRECTION (found during implementation):** composing at the *pool* CANNOT soundly enforce M-of-N for shielded notes. The pool can't tell which spent notes belong to a dual-control org — the spender is hidden by design — so an *optional* org-auth proof verified at the pool can't FORCE presence: a malicious org member would simply omit it and spend via a normal `transfer`. The pool-compose gives a verifiable *attestation* ("an M-of-N approval exists for H(this transfer)") but not *mandatory* dual-control. **Sound enforcement requires the M-of-N INSIDE the joinsplit circuit** — when the spent note is org-controlled, the spend proof itself must carry the threshold (so the note is unspendable without it). That is your in-circuit choice, and it does mean the larger, ceremony-invalidating joinsplit merge. The `org_spend_auth` circuit (the M-of-N gadget) + `org_account.member_root` (the on-chain member-set the joinsplit would check `orgMemberRoot` against) are the reusable pieces; the merge wires the gadget into `joinsplit_impl.circom` gated on an `isOrgControlled` note flag.
- **Member registry (real gotcha):** the circuit's member tree uses **circomlib Poseidon** (via `merkleProof.circom`/`MerkleTreeMirror`), but Soroban's host hash is **Poseidon2** (CAP-0075). So an on-chain org-member registry can't naively reuse the Poseidon2 `mvk_registry`/`merkle` contracts — the roots won't match. Options: (a) the org publishes a signed member-root the pool trusts (simplest), (b) a circomlib-Poseidon Merkle verified in a small contract, or (c) switch the circuit to Poseidon2 (another circuit change). This compatibility decision gates the registry design.
- **SDK:** the send path collects M member EdDSA signatures over `spendMessage`, builds the witness, proves `org_spend_auth`, and submits both proofs.
- **Ceremony:** one multi-party ceremony over `org_spend_auth` (dev key today) before mainnet.

This is a multi-day change to the **critical pool contract** + a ceremony; it should be done deliberately (not rushed), with the Poseidon-vs-Poseidon2 member-root decision made first.

### ⚠️ Deeper finding (after reading the full joinsplit): FROST > in-circuit for the *enforcement* locus

Merging M-of-N *inside* joinsplit hits two costs that off-circuit **FROST** avoids:

- **Org-note ownership.** A shielded note is owned by a single spend key `ak` (commitment binds `recipientPk = pk(ak)`; nullifier = `f(nk, leafIndex)`). For a dual-control org, *no single party holds `ak`* — that's the whole point. So an in-circuit merge must redesign org-note ownership (member sigs instead of `ak`-knowledge) **and** invent an org-note **nullifier** that is double-spend-safe yet **unlinkable**. A naive org nullifier (`f(orgId, leafIndex)`) leaks the org's spend graph on-chain — a privacy regression for a confidential-payroll product. Solving this soundly is a research-grade redesign (the rewrite-risk P0).
- **Ceremony + critical-circuit churn.** It re-proves and re-ceremonies the load-bearing transfer circuit.

**FROST (threshold signatures, off-circuit)** sidesteps both: the org's `ak` is FROST-shared among members; M members produce one aggregated signature that *is* the spend authority, so the joinsplit circuit is **unchanged** (it just sees a normal `ak` spend), the on-chain footprint is **indistinguishable from a single-key spend** (privacy preserved, no org-note linkability), the **ceremony is preserved**, and **consumer org-of-one is the byte-identical N=1 degenerate case**. M-of-N is enforced because `ak` is unreconstructable without the threshold of members.

**Recommendation (revisits the earlier in-circuit choice):** use **FROST** as the enforcement locus. The `org_spend_auth` circuit we built remains useful as an *attestation/audit* primitive (prove "an M-of-N approval exists for this spend" to an auditor) and as the basis for the dual-control *policy*, but the *spend-gating* should be FROST, not an in-circuit joinsplit merge. This is the privacy- and ceremony-preserving sound design the key-hierarchy split (ak/nk) was built for.

> **Decision (2026-06-21): the owner picked the in-circuit merge anyway** (with the privacy/ceremony tradeoffs on record). Build it via the staged spec below.

### Sound in-circuit merge — the spec (no explicit org-flag needed)

The soundness anchor is **preimage resistance of the note's `recipientPk`**, so no separate (forgeable) "is-org" flag is needed:
- **Normal note:** `recipientPk = BenzoKeypair(ak)` = `Poseidon2(ak,0; KEYPAIR_DOMAIN=0x03)`. Spent by proving knowledge of `ak` (the single-signer path), exactly as today.
- **Org note:** `recipientPk = Poseidon2(orgMemberRoot, threshold, akGroupPub; ORG_NOTE_DOMAIN=0x09)` where `akGroupPub = BenzoKeypair(akGroup)` commits to the org's secret group key. The org identity binds the member-set root, the threshold, **and** the group key. Spent only via the M-of-N path: the spender supplies `orgMemberRoot`+`threshold`+M member EdDSA sigs and the circuit checks the anchor equals `recipientPk`.
- **Why a malicious org member can't downgrade:** to spend an org note via the single-signer path they'd need an `ak` with `BenzoKeypair(ak) == recipientPk` — a Poseidon2 preimage of the org identity — infeasible (and 0x03 vs 0x09 domains make the two recipientPk families disjoint). A different attacker-controlled member set or `akGroup` hashes to a different `recipientPk`. So the note's `recipientPk` **forces** the correct path; the flag is implied, not asserted.
- **Nullifier (the hole the adversarial review found, now fixed):** the live joinsplit derives `nullifier = Poseidon2(nk, leafIndex)` from `nk = BenzoSpendKeys(orgSpendId).nk` — but an org note has *no* `orgSpendId` whose keypair equals its org `recipientPk`, so that derivation is **undefined** for org notes. The sound construction: `nk_org = Poseidon2(akGroup, blinding; NK_DOMAIN=0x07)`, then `nullifier = Poseidon2(nk_org, leafIndex; 0x02)`.
  - **Canonical (no double-spend):** `akGroup` is pinned by `recipientPk` (via `akGroupPub`), `blinding` + `leafIndex` are pinned by the note commitment + pool Merkle membership in the merged joinsplit. So exactly one nullifier per note.
  - **Unlinkable (no org spend-graph leak):** keyed on the per-note `blinding`, so two notes of the *same* org yield uncorrelated nullifiers; keyed on the secret `akGroup` (NOT the viewing key), so the auditor/MVK holder — who can see amounts — still cannot link spends (Zcash `nk`/`ivk` split). **Do NOT push `orgMemberRoot` as a public input** (it would publicly reveal which org spent); bind it only through `recipientPk`.
  - Status: built + green — `note.circom` `BenzoOrgNoteIdentity`/`BenzoOrgNullifierKey`; `org_note_spend` (48,392 constraints) proves all three legs; `org-note-spend.test.ts` 9/9 incl. tampered-nullifier reject, wrong-`akGroup` reject, and the unlinkability assertion.

**Staged build** (each stage verifiable; none touches the live `joinsplit` until a reviewed cutover): (1) **DONE** `org_note_spend` = M-of-N + the `recipientPk` anchor + the canonical/unlinkable org nullifier above; (2) merge the two spend paths into a `joinsplit_org` variant (2-in/2-out, per-input selector forced by `recipientPk`, **muxing both the recipientPk-into-commitment and the nullifier derivation** — built by *copying* `joinsplit_impl.circom`, never editing it); (3) larger ptau — measured: live joinsplit 49,819 + 1 org input 46,714 = **96,533 (needs 2^17)**, 2 org inputs = 143,247 (needs 2^18); the Hermez universal phase-1 ptau is publicly downloadable (no new phase-1 ceremony); (4) SDK witness (`OrgMemberTreeMirror` + circomlibjs EdDSA signing, collect M sigs, build org notes) + a `transfer_org` Soroban entry reusing all replay/root/ext-hash logic + a new `JSPLITORG` VK (symbol_short ≤ 9 chars); (5) multi-party **phase-2** ceremony; (6) cutover. Stages 3-6 are the multi-week, ceremony-invalidating part on the critical circuit (5-6 need the owner: real funds + human ceremony).

## 7. What stays a (thin, non-custodial) server — and why that's fine

Being honest about "no backend": three things touch a server, none of them custodial:

1. **Gas relayer** — stateless fee-bump; sees only public data; self-hostable; replaceable.
2. **Handle directory** — public handle→address lookup; ideally an on-chain Soroban contract (then it's not a server at all).
3. **Fiat ramp** — a regulated third party by law; isolated behind an adapter; off by default for pure crypto users.

Everything that defines Benzo — **keys, proving, note discovery, balances, business logic, privacy** — runs on the client and is secured by ZK + the chain. That is the thesis, delivered as far as physics and regulation allow.
