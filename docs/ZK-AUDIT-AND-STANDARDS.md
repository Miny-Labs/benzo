# Benzo ZK Audit & Standards Reference

**Status:** pre-build engineering reference. Captures (A) an audit of the *existing* ZK against top-tier
implementations, (B) the *new* ZK features spec'd to industry standard, and (C) the unified plan that folds
both into a single pre-ceremony circuit batch. Build from this.

## Implementation status (branch `zk-standards-build`)

Landed and verified green (105/105 core tests, 14/14 touched-contract tests, full workspace builds):
- ✅ **Step 0 — browser-safe `viewkeys.ts`**: ported off `node:crypto`/`Buffer` to `@noble/ciphers` +
  WebCrypto (`./crypto/random`, `./crypto/bytes`); the `BNZ1` sealed-box format is byte-identical so existing
  notes still decrypt. Unblocks the browser/proving track.
- ✅ **Key-hierarchy split (A.3 P1 "merge bug" + B.1 foundation)**: `note.circom` now derives a spend-auth key
  `ak = Poseidon2(orgSpendId,0,0x06)` and a SEPARATE nullifier key `nk = Poseidon2(orgSpendId,1,0x07)` via
  `BenzoSpendKeys`; ownership binds `ak`, nullifier binds `nk`. Propagated to joinsplit/unshield/proof_of_balance
  (private `inSpendSk → inOrgSpendId`, no public-input change) and the SDK (`deriveSpendKeys`). Circuits
  recompiled + zkeys regenerated; prove+verify confirmed. N=1 consumer is the degenerate case.
- ✅ **`validate_vk` hardening (A.3 P1)**: `verifier_groth16` now rejects `gamma==delta` and zero/degenerate
  alpha/beta/gamma/delta (the Veil/VeilCash trivial-forgery class) at registration/rotation.
- ✅ **`identity_nullifier_set` contract (B.2 sybil)**: new crate; `register` REJECTS a duplicate identity
  nullifier (one human, one account) — the non-idempotent sibling of the spend nullifier set.
- ✅ **`proof_of_sum` circuit + SDK helper (B.3 MVP)**: new circuit proving `Σ(owned notes) === claimedTotal`,
  revealing only the total — the ZK replacement for the plaintext `disclosedTotal()`. Proves the exact total and
  rejects any lie about the sum; `sum.ts` (`proveSum`/`verifySumLocal`) wires it into the SDK. *Completeness/
  universe binding (no under-reporting) is the documented follow-on — it composes with the authorized-MVK registry.*
- ✅ **Poseidon2 host-vs-TS differential GATE (A.3 P1 / C Step 2)**: `soroban-utils` test asserts the CAP-0075
  host `poseidon2_hash2` (t=3) and `poseidon2_compress` (t=2) are byte-identical to the TS/circom mirror for the
  domains in use — the pre-ceremony param-drift gate. (t=4 is circuit/SDK-only, covered by the circuit tests.)
- ✅ **`org_account` contract (B.1 dual control)**: new crate — the on-chain org primitive (FROST group key `ak`,
  threshold, members, rotation epoch) + a real dual-control approval state machine: M-of-N *distinct* approvals,
  segregation of duties (proposer cannot approve their own proposal), offboarding via epoch rotation. Replaces the
  BFF's fake approve-on-first.

- ✅ **`registeredMvkRoot` binding — the P0 "compliance is theater" fix (B.4 / A.2), circuit + SDK** across ALL
  three money paths: `shield`, `joinsplit` (both outputs), and `unshield` (change note) now require `mvkPub` to be
  a NONZERO leaf in the authorized-MVK registry root (`BenzoMvkRegistryLeaf` + in-circuit Merkle membership +
  `IsZero` guard). A junk/unregistered or all-zeros key is cryptographically rejected (verified by the shield
  negative tests). Public-input layout updated (shield 6→7, transfer 10→11, unshield 8→9); `pool.ts` witness
  builders + `notes.ts` `mvkRegistryLeaf` updated; circuits recompiled.
- ✅ **`registeredMvkRoot` ON-CHAIN enforcement (`pool.rs`)**: `shield`/`transfer`/`withdraw` now take a
  `registered_mvk_root` arg, push it as the final public input, and `check_mvk_root` validates it via
  `is_known_root` against a configured `mvk_registry` (set by `set_mvk_registry`). Pool tests
  updated (13/13) including `mvk_registry_rejects_unknown_root` (an unknown root → `WrongMvkRoot`).

- ✅ **`mvk_registry` contract + SDK mirror (B.4)**: new `contracts/mvk_registry` crate — an append-only,
  128-root-history Merkle accumulator of authorized MVKs. `register_mvk(mvk_pub, key_meta)` computes the leaf
  `Poseidon2(mvk_pub, key_meta, 0x08)` (byte-identical to the circuit's `BenzoMvkRegistryLeaf` and the SDK's
  `mvkRegistryLeaf`), rejects the zero key and double-registration, and exposes `is_known_root`/`current_root`
  so the pool's `MerkleClient` works against it unchanged (deployed with `levels = 16` to match `mvkLevels`).
  8 tests, including a **cross-contract equivalence** test proving `register_mvk` wraps `leaf_of` in the exact
  same tree as the audited `benzo-merkle` (so re-deriving Poseidon2 here is unnecessary — that's gated by the
  t=3 host differential). SDK side: new `MvkRegistryMirror` (`packages/core/src/mvk-registry.ts`) replaces the
  triplicated inline single-leaf stand-in with one documented seam — dedup by `mvkPub`, nonzero rule, a
  `singleLeaf()` default, and a synced mode (replay `MvkRegistered` events) for production; wired into
  shield/transfer/unshield (4 tests; root matches a plain tree over the same leaves). **Remaining for
  production:** deploy + populate the on-chain registry and switch the mirror to synced mode; deploy the new
  VKs via the real ceremony.

- ✅ **`kyc_credential` circuit — KYC-as-ZK (B.2), the compliance-spine headline**: vendored the full circomlib
  BabyJubJub/EdDSA-Poseidon stack (circomlib 2.0.5) into `circuits/lib/circomlib`, and authored a credential
  circuit that verifies an issuer EdDSA-over-BabyJubJub signature in-circuit (with the mandatory S<l malleability
  guard), proves issuer-registry Merkle membership, checks expiry, binds the credential to the holder's own key,
  and emits a Semaphore-style one-person-one-scope sybil `identityNullifier` + an `admitLeaf` for proof-gated
  admission. Verified end-to-end (`kyc.test.ts` uses `circomlibjs` to build real signatures): a valid credential
  proves, and tampered-signature / unregistered-issuer / expired-credential all FAIL.
- ✅ **`asp_membership.admit_by_proof` — proof-gated admission (the highest-leverage trust removal)**: a holder is
  admitted into the allow-set by a valid `kyc_credential` proof (verified fail-closed via the configured verifier),
  with the `admitLeaf` cross-checked against public input #6 and inserted WITHOUT admin auth — the proof IS the
  authorization, replacing the operator-trusted insert; no PII on chain. Tests (25/25, real arkworks proofs):
  valid credential admits, a mismatched leaf or a non-verifying proof is rejected. So the full compliance spine —
  **KYC credential → proof-gated admission → sybil set** — is implemented + verified. **Remaining:** real
  Plaid issuer keys (KYB + Identity Verification) + HSM + revocation.

- ✅ **Proving systems (B.5) — on-device + delegated**: `WasmProver` (browser-portable: proves from preloaded
  `Uint8Array` artifacts, no `node:fs`, with progress callbacks — verified proving from in-memory buffers);
  `DelegatedProver` (remote prover for low-power/batch — MVP trusted-delegate, witness-hiding is the mainnet
  hardening); and a new **`packages/proving-worker`** package whose `WorkerProver` runs `WasmProver` in a Web
  Worker so a multi-second proof never blocks the UI thread (RPC verified with a fake worker: result/progress/
  error/concurrent routing). The `deriveSpendKeys` SDK piece was already done with the key hierarchy.

- ✅ **Client-side signing split (B.5 custody-seam removal)**: new `packages/core/src/tx-signer.ts` — a
  `TxSignerPort` (Freighter-shaped: `signTransaction(xdr,{networkPassphrase})`) is now the custody boundary, so
  the *user's own* key signs writes instead of a relayer holding `DEPLOYER_SECRET`. `LocalKeypairSigner` backs
  Node/CLI/self-host and tests; a browser drops in `@stellar/freighter-api`/`smart-account-kit` with no adapter
  (or `signerFromFn`). `buildInvokeTx` (build → simulate → assemble) + `signAndSubmit` (sign-once, poll to
  finality) compose into `makeClientSubmitWrite`, a drop-in for `StellarRpcOptions.submitWrite` — flipping a
  wallet from custodial-relayer to self-signed is a one-line swap. The CLI-arg→ScVal coercion was factored into
  `scval.ts` (shared read+write surface) and extended with `proofToScVal` (the Groth16 `--proof` struct →
  `ScMap{a,b,c}`). Headless coverage (8 tests, no live chain): signature verifies against the tx hash under the
  signer key; send-once + poll-past-`NOT_FOUND` + `FAILED`/`ERROR` throw; proof struct + arg ScVal shapes.
  **Remaining for B.5:** the witness-hiding TEE/coSNARK transport for `DelegatedProver` (mainnet hardening), and
  testnet validation of the assembled-write path against a live RPC.

- ✅ **Frontend primitives (`packages/ui` + `packages/wallet` + `packages/proving-worker`)**: the shared,
  framework-agnostic layer both apps consume — *logic only*, screens stay per-app. **`@benzo/wallet`**: an
  on-device `Keychain` that AEAD-seals the wallet's secrets (Stellar key, org spend identity, MVK seed) into a
  `KVStore` (IndexedDB in-browser, in-memory in Node/tests), unlocked by a passkey-PRF or scrypt-passphrase
  wrapping key, handing out a `TxSignerPort` that closes the loop with the non-custodial signing split (10
  tests). **`@benzo/ui`**: the privacy/payment state machines (shielded-payment lifecycle build→prove→submit→
  confirm, proving-status mapping, keychain lock, balance masking, money parse/format that refuses to drop a
  user's cents) as pure reducers + thin React hooks (13 tests; hooks typecheck against `@types/react`).

**Full suite green together:** `cargo test --workspace` (every contract, incl. `mvk_registry`) + 128 `@benzo/core`
+ 10 `@benzo/wallet` + 13 `@benzo/ui` + 3 `@benzo/proving-worker` + the other package suites — 200 TS tests pass.

Remaining — all either need live infra or external parties, none solo-completable: deploying + populating the
`mvk_registry` on testnet and switching `MvkRegistryMirror` to synced mode; on-chain VK registration +
recompiled-r1cs deploy (needs a live testnet pool/verifier); the witness-hiding TEE/coSNARK `DelegatedProver`
transport and testnet validation of the assembled client-write path; a **real multi-party ceremony**
(independent contributors + public beacon); full e2e (needs a live chain). The current dev zkeys are an honest
single-author setup — NOT production-trustworthy (A.2 P0) until the real ceremony.

**Scope reminder:** testnet/self-host/sandbox. Only the fiat bank leg and KYC issuers are mocked; everything
cryptographic is real. "hackathon-mvp" vs "mainnet-only" tags mark what each item needs.

---

## 0. Executive summary

Benzo's **ZK arithmetic core is at or above industry par** and must not be reworked: value conservation +
full 64-bit range checks, on-chain nullifier canonicality against the *scalar* field `r` (the snarkjs #480
lesson), Merkle membership soundness, the Groth16/BN254 verifier mechanics, the pinned Poseidon2 t=4
parameter set, and the Zcash-style supply turnstile are all correct.

It is **below par on two ship-blocking axes**, plus the new features must be designed to standard *now*
because of one governing constraint:

> **Every circuit change invalidates the trusted setup.** So all circuit-layout changes — the existing-ZK
> fixes *and* every new-feature circuit — must be batched into ONE frozen change-set, gated on a Poseidon2
> host-vs-guest differential test, then sealed by ONE real multi-party ceremony. Nothing re-touches a circuit
> after the ceremony starts.

Everything VK-agnostic (WASM/delegated proving, the signing split, contracts, SDK, compliance) rides outside
the freeze and proceeds in parallel.

---

## A. Audit of the existing ZK

### A.1 At or above par — DO NOT TOUCH
- **Value conservation + range checks** — explicit field equations (`sumIns === sumOuts + fee`;
  `inAmount === publicAmount + changeAmount`) with every value `Num2Bits(64)` range-checked, including input
  amounts (hardened beyond tornado-nova). `joinsplit_impl.circom:61-62/127`, `unshield_impl.circom:96`.
- **Nullifier canonicality on-chain vs scalar field `r`** — `push_input` rejects `value >= r` before the
  element enters `vk_x` (closes the `x` vs `x+p` double-spend class); dedup keys off the canonical nullifier
  in persistent storage, not proof bytes (Groth16 malleability does not enable double-spend).
  `pool.rs:691-704`, `nullifier_set/src/lib.rs:36-39`.
- **Merkle membership** — boolean path bits, fixed depth 32, dummy/zero-amount inputs gate the root check via
  `ForceEqualIfEnabled`, zero-root never accepted, 128-slot root-history ring. `merkle/src/lib.rs:158-239`.
- **Groth16 verifier** — canonical pairing `e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ)==1`, host-enforced G1 on-curve +
  G2 subgroup + CAP-74 flag validation. `verifier_groth16/src/lib.rs:165-206`.
- **Public-input encoding/order** matches the circuits bit-for-bit. `pool.rs:244-378/488-506`.
- **Ext-data binding + single-use nullifier set + the supply turnstile** (an above-par compensating control
  that bounds the blast radius of any undiscovered soundness bug to actually-deposited funds).
- **Poseidon2 params** — correctly-pinned Noir/Aztec t=4 set (d=5, RF=8, RP=56), asset id bound in every
  commitment (multi-asset safe), disciplined domain separation. `poseidon2.rs:44/99`, `note.circom:46-51`.

### A.2 P0 — critical, ship-blocking
1. **The auditability guarantee is unenforced (compliance is theater).** `mvkPub` is a free, unconstrained
   private signal whose only constraint is `mvkTag = Poseidon2(mvkPub, blinding)`; it is not a public input
   and nothing on-chain checks it is a *registered* viewing key. A prover can pick an `mvkPub` nobody holds
   the key for and mint a fully-spendable, **permanently-unauditable** note — falsifying the "no path to an
   unauditable note" claim. *Fixed by the authorized-MVK registry (B.4).*
   Files: `note.circom:67-79`, `shield_impl.circom:34/53/55`, `joinsplit_impl.circom:47/111/113`,
   `unshield_impl.circom:84`, `viewkey_anchor/src/lib.rs:116-128`.
2. **The trusted setup is not production-trustworthy.** `scripts/ceremony.sh` runs all contributions + a local
   `/dev/urandom` "beacon" on ONE machine; only `joinsplit` has any ceremony; the deployed joinsplit VK does
   not byte-match its own transcript; ptau on disk is undersized. Toxic-waste holders could forge proofs
   (capped only by the turnstile). **Treat current VKs as non-production.** *Fixed by the one real ceremony (C.4).*

### A.3 P1 — high
- **Single-key governance on the money path** — one admin key controls `set_verifier` (re-point the pool at
  an always-true verifier) and `rotate_vk`. Needs multisig/timelock + a VK-digest allowlist.
  `pool.rs:582-591`, `verifier_groth16/src/lib.rs:124-135`.
- **`validate_vk` too weak** — only checks `ic.is_empty()`; must also reject `gamma==delta`, reject the
  G2-generator/placeholder, and assert IC length == circuit arity (the Veil/VeilCash trivial-forgery class).
  `verifier_groth16/src/lib.rs:69-74`.
- **Single-actor spend collapses spend-auth + nullifier + ownership into one scalar** — `recipient_pk` and
  `nullifier` both derive from one `spendSk`. This is the canonical key-hierarchy violation. *Fixed by the
  key-hierarchy split (B.1).* `keypair.circom:9-20`, `note.circom:26-65`, `joinsplit_impl.circom:64-76`.
- **Poseidon2 t=3/t=4 host-vs-guest differential untested** — the exact CAP-0075 risk (param drift → all
  honest proofs rejected or a weakened hash) has no real host-vs-circuit KAT for the note-commitment hash.
  Must pass as a pre-ceremony gate (C, Step 2).

### A.4 P2 — medium (hardening; land after the gates)
- **Predictable dummy-nullifier collision** — a fixed placeholder dummy emits a deterministic nullifier the
  pool marks spent; a predictable placeholder can be front-run to burn a shared nullifier (liveness/DoS, not
  fund loss). Constrain dummy inputs to a per-tx-unique pseudorandom nullifier, or pool-skip amount-0 inputs.
- **`proof_of_balance` binds context with only `context²`** (does not distinguish a value from its
  field-negation) and has **no on-chain verifier**. Bind context into a structured hash; add the verifier.
- **Note encryption diverges from ZIP-212** (raw esk, no decrypt-time `epk` check). Low impact unless
  diversified-address unlinkability is in scope — either adopt ZIP-212 rseed-derived esk or document it out.

---

## B. New features — spec'd to industry standard

Each follows a named top-tier reference and folds into the one pre-ceremony batch.

### B.1 Org-of-one threshold spend + key hierarchy — *follows Zcash Orchard / Penumbra / ZIP-312 + FROST*
Split the single `spendSk` into a **spend-auth branch `ak`** and a **separate nullifier key `nk`**, both
derived from one committed `orgSpendId` via domain-separated Poseidon2. `nullifier = Poseidon2(nk, leafIndex)`
(unchanged shape); `recipient_pk = Poseidon2(ak, 0)`. M-of-N authorization is **off-circuit FROST**
re-randomized threshold-Schnorr — the spend circuit stays single-signer, so **N=1 (consumer) is the literal
zero-extra-constraint degenerate case**, byte-identical to N-of-M.
- **Circuit impact:** EXTEND, *no public-input change* (private rename `inSpendSk[] → inOrgSpendId[]` + one
  extra Poseidon2 per spent note). VK changes → in the batch. New `contracts/org_account` (T, group key = ak,
  member set). Effort M. Hackathon (1-of-1) → mainnet (M-of-N).
- **Avoids:** per-approver nullifiers (double-spend), the spend-auth/nullifier merge (the current Benzo bug),
  single-place secret reconstruction. Reference: ZIP-312, ZcashFoundation/frost, Penumbra threshold custody,
  Railgun/Semaphore nullifier form.

### B.2 ZK-KYC credential + sybil nullifier — *follows Galactica zkKYC + iden3 EdDSA + Semaphore v4*
Issuer signs `Hash(attrs, subjectBinding, issuerKeyId, expiry)`; a new `kyc_credential.circom` verifies the
in-circuit EdDSA-BabyJubJub signature + issuer-registry membership + expiry + re-derives the subject binding,
and emits a scope-bound sybil nullifier. Admission becomes proof-gated (`asp_membership.admit_by_proof`).
- **Repo blocker:** the vendored `circomlib` is trimmed — **no `babyjub`, `eddsa`, `escalarmul`, `montgomery`,
  `pointbits`.** Vendor these verbatim from upstream iden3 first; run `circomspect` to confirm the S<l
  malleability guard, A≠0, cofactor-8.
- **Circuit impact:** NEW circuit (own VK), does not touch existing layouts. New `issuer_registry` +
  `identity_nullifier_set`. Effort L. Hackathon (self-issued demo issuer) → mainnet (Plaid for both:
  KYB for business, Identity Verification for personal; HSM keys, revocation SMT).
- **Avoids:** EdDSA malleability (gnark CVE-2025-57801 / S<L), unconstrained `enabled`, free-input
  `currentTime`.

### B.3 ZK disclose-total + completeness — *follows Summa/Maxwell Merkle-sum + DAPOL+ completeness*
New `proof_of_sum.circom` proves `Σ(in-scope notes) === claimedTotal` over a Poseidon Merkle-sum-tree, **plus
a bidirectional set-equality (completeness) proof** that the disclosed set equals the universe of notes
tagged to the org's registered MVK — so an employer **cannot omit the high-salary note**. Replaces today's
plaintext `disclosedTotal()` (`client.ts:721`) that leaks every salary.
- **Circuit impact:** NEW circuit + public-input change (introduces `mvkPub`, `universeRoot`); reuses the
  authorized-MVK SMT from B.4. Effort L. Mainnet-only.
- **Avoids:** the max-not-sum attack (node commits to summed *and* unsummed children), field-wraparound
  negatives (64-bit range checks), cherry-picking.

### B.4 Authorized-MVK registry binding (the P0 fix) — *follows EIP-8182 §8.1 + PrivacyBoost verifyAuth*
Make `mvkPub` a public input bound to a `registeredMvkRoot` via in-circuit Merkle membership + `mvkPub ≠ 0`,
across shield/transfer/unshield. New `contracts/mvk_registry` (fork of `merkle` with the 128-root ring).
- **Circuit impact:** EXTEND with public-input change (the `registeredMvkRoot` append). Effort M. Mainnet
  (drain-and-re-shield on testnet). Reuses `merkleProof.circom` (avoids the Aleo non-unique-index bug).
- **Avoids:** the all-zeros / well-known-key attack (the P0), OVK-unverified, non-unique Merkle index.

### B.5 Proving systems — *follows snarkjs + coCircom/TACEO + TEE*
Two-tier: **Tier 1** on-device snarkjs `groth16.fullProve` in a Web Worker (COOP/COEP isolation, IndexedDB
artifact cache) + client-side signing (retire the single `DEPLOYER_SECRET`); **Tier 2** a **witness-hiding**
`DelegatedProver` (coCircom/TACEO MPC or TEE) that secret-shares the witness so the delegate never sees
private inputs.
- **Circuit impact:** NONE — same R1CS, byte-identical Groth16 proofs (the parity test is the regression
  guard). Effort L. WasmProver + `node:crypto` fix + signing split = hackathon; MPC/TEE delegated = mainnet.
- **Avoids:** WASM OOM, silent single-thread halving, the public-delegation privacy leak.

---

## C. The unified plan — one batch, one ceremony

### C.1 Frozen public-input contract (decide once, before any zkey)
| Circuit | Today | After |
|---|---|---|
| shield | 6 inputs | + `registeredMvkRoot` as #7 (final) |
| transfer/joinsplit | 10 inputs | + `registeredMvkRoot` as #11 (final) |
| unshield | 9 inputs | + `registeredMvkRoot` as #10 (final) |
| proof_of_balance | unchanged | unchanged layout (VK still changes via key-hierarchy) |
| proof_of_sum | — | NEW `[root, claimedTotal, assetId, mvkPub, scopeTag, inScopeCount, universeRoot, context]` |
| kyc_credential | — | NEW `[issuerRegistryRoot, credType, currentTime, scope, identityNullifier, addressBinding, admitLeaf]` |

Pool `push_input` appends `registered_mvk_root` as the final element in each existing vector — no reorder.

### C.2 Canonical domain-separation map (frozen — collision-resolved)
Existing `0x01`–`0x05` stay (ASP, nullifier, keypair, legacy-sig, mvk-tag). New:
`0x06` ask · `0x07` nk · `0x08` mvk-registry-leaf · `0x09` kyc-msg · `0x0A` issuer-keyid ·
`0x0B` holder-commit · `0x0C` sybil-null · `0x0D` admit-leaf · `0x0E` universe-node.
A domain reshuffle after the ceremony = full re-run.

### C.3 note.circom edits (the shared seam — propagates to all circuits)
- Add the domains above; add `BenzoSpendKeys(orgSpendId) → {ak=Poseidon2(orgSpendId,0,0x06),
  nk=Poseidon2(orgSpendId,1,0x07)}`; re-key `BenzoNullifier` on `nk`; keep `BenzoKeypair` shape feeding `ak`.
- Replace the bare `BenzoMvkTag` with `BenzoMvkBinding(mvkLevels)` = registry-leaf → `MerkleProof` →
  `=== registeredMvkRoot`, plus `mvkPub != 0`.
- Author `proof_of_sum_impl.circom` and `kyc_credential.circom` circuit-complete.
- In `joinsplit_impl`/`unshield_impl`/`proof_of_balance_impl`: rename `inSpendSk[] → inOrgSpendId[]`.

### C.4 The one ceremony
Run a single real multi-party Groth16 phase-2 over the 6-circuit batch
`{shield, transfer, unshield, proof_of_balance, proof_of_sum, kyc_credential}`:
- N≥3 **independent** contributors on separate machines per circuit (replacing the single-machine simulation);
- a **public verifiable beacon** (drand / a future block hash, not `/dev/urandom`);
- published per-contributor attestations including ≥1 toxic-waste-destruction attestation;
- `snarkjs zkey verify` over the full transcript chain against freshly-compiled r1cs;
- **re-measure r1cs for the whole batch and size ptau to the largest circuit** (current 2^16 is undersized for
  joinsplit alone → 2^17/2^18);
- register/rotate all 6 VKs (`set_vk` is immutable per id → `rotate_vk` for the three already on testnet),
  pin each VK sha256 in `deployments/*.json`, flip `REQUIRE_VK_PROVENANCE` default to 1.

### C.5 Build sequence
0. **(parallel, hackathon)** Fix the `viewkeys.ts` `node:crypto` leak (→ `@noble/ciphers` + WebCrypto, keep the
   `BNZ1` wire format). Unblocks the browser bundle; no circuit coupling.
1. **(freeze-critical)** Lock the open decisions (C.6), edit `note.circom` once, author the two new circuits,
   append `registeredMvkRoot`, recompile all r1cs, size ptau.
2. **(GATE)** Poseidon2 host-vs-guest differential test (t=3 **and** t=4, all new domains) — blocks the ceremony.
3. **(hackathon→mainnet boundary)** The one real ceremony (C.4). Hackathon may run a smaller honest ceremony
   over the *same batch composition*; mainnet re-runs it as the full N-party ceremony with no circuit change.
4. **(contracts, post-ceremony)** `mvk_registry` [mainnet], `org_account` [hackathon], `issuer_registry` +
   `identity_nullifier_set` [hackathon]; wire `pool.rs` to validate + push `registeredMvkRoot` and gate the
   org policy; `asp_membership.insert_leaf → admit_by_proof`; `viewkey_anchor.prove_total` + ordered-tag
   accumulator [mainnet].
5. **(SDK/proving, parallel, VK-agnostic)** `deriveSpendKeys(orgSpendId) → {ak, nk}`; WasmProver + worker +
   IndexedDB artifact cache + COOP/COEP; `TxSignerPort` splitting `DEPLOYER_SECRET` → sponsor + relayer;
   `DelegatedProver` (MPC primary / TEE fallback); `disclose-total` rewriting `client.ts:721`. All load VKs via
   one versioned manifest, so the ceremony is a manifest bump with zero prover-code change.
6. **(compliance/off-chain)** FROST coordinator (DKG group key = ak, RTS + Refresh-Share rotation keeping
   ak/nk/nullifiers fixed); KYC issuers (self-issued demo → real Plaid (KYB + IDV) + HSM + revocation SMT).
7. **(tests/e2e)** Assert `ak != nk != orgSpendId` and `nf` depends only on `nk`; N=1 reproduces today's
   nullifier; unregistered/`mvkPub=0` MVK fails; disclose-total with an omitted high-salary note FAILS and only
   `claimedTotal` is revealed; tampered/expired/wrong-issuer KYC FAILS; double-admit same scope-nullifier
   rejected (sybil); extend `pool/src/test.rs` snapshots for the new final input.

### C.6 Open decisions to lock before the freeze
1. **Dual-control enforcement locus** — recommended **off-circuit FROST** (no in-circuit sig constraints,
   byte-identical N=1..N, no BabyJubJub on the spend path). In-circuit EdDSA-registry documented as
   rejected-for-now. *This is the org-account-gate decision and it gates `note.circom`.*
2. **Domain map** — the C.2 allocation.
3. **Legacy-VK migration** — recommended **drain-and-re-shield** on testnet (the public-input change strands
   old notes; record before touching circuits).
4. **`registeredMvkRoot` freshness window** — root-history depth in `mvk_registry` (liveness vs
   revoked-key-reuse); reused for `proof_of_sum`'s `universeRoot` epoch pinning.
5. **`capNotes` / disclose-total arity** — per-proof note budget (16/32) + the second-level Merkle-sum
   aggregation shape for payroll universes beyond the cap.
6. **`mvkMeta` bit-packing** — `org-id || scope || expiry || key-epoch` layout (affects the leaf hash and the
   MVK→TVK derivation; a later repack invalidates the registry root + ceremony).
7. **Shield ciphertext binding gap (ZIP-310)** — transfer/withdraw fold `H(mvk_ct)` into `ext_data_hash`;
   shield does not. Decide whether shield gets an in-circuit `mvkCtHash` public input (layout change — must be
   in the batch) or documents it as off-chain-integrity-checked.

---

## D. What is hackathon-MVP vs mainnet

**Hackathon (build now):** the viewkeys browser fix; the frozen circuit batch with the key-hierarchy split,
the MVK-registry binding, `kyc_credential` (demo issuer), `proof_of_sum`; the Poseidon2 differential gate; a
batch-composition-identical ceremony for demo VKs; `org_account` 1-of-1; WasmProver + signing split + a
*labeled* trusted/TEE delegated prover; `admit_by_proof` with one demo credential.

**Mainnet-only:** the full N-party ceremony; real Plaid issuers (KYB + IDV) + HSM + revocation; the witness-hiding
coSNARK/TEE delegated prover; ASP allow-set de-authorization; multisig+timelock on `set_verifier`/`rotate_vk`;
source-of-funds-to-anchor, withdraw-cap + de-correlation; proof-of-reserves; per-member TVK revocation +
forward-secret epochs.

**Do not** rebuild proof-of-innocence (real & correct) or chase proof-of-reserves / RISC-Zero verifiable
compute before the KYC-credential → admission → disclose-total spine exists.
