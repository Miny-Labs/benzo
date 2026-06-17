pragma circom 2.2.2;

// Benzo proof-of-funds attestation.
//
// Proves the holder possesses an ORACLE-SIGNED bank-balance attestation showing
// `balance >= threshold`, that the attestation is FRESH (not stale), and that it
// is bound to the holder — WITHOUT revealing the balance, the timestamp, or the
// bank. The oracle (a Plaid-backed Phala enclave) signs
// Poseidon(holderBinding, balance, assetId, timestamp) with EdDSA-over-BabyJubJub
// (circomlib EdDSAPoseidonVerifier, which carries the mandatory S<l malleability
// guard). The on-chain contract pins the oracle via the public `oracleKeyId`.
//
// SOUNDNESS NOTE: this is an ORACLE-backed claim. Its trust base is
// (Plaid data integrity + the enclave's attested signing key), which is distinct
// from — and weaker than — the pure-Groth16 soundness of the shielded pool. It
// is deliberately fenced off and labeled as such.
//
// Public  : [oracleKeyId, threshold, assetId, currentTime, maxAgeSeconds, holderBinding]
// Private : oracle pubkey + signature, balance, timestamp, holder secret.

include "../lib/circomlib/circuits/eddsaposeidon.circom";
include "../lib/circomlib/circuits/poseidon.circom";
include "../lib/circomlib/circuits/babyjub.circom";
include "../lib/circomlib/circuits/bitify.circom";
include "../lib/circomlib/circuits/comparators.circom";

template FundsAttestation() {
    // ---- public ----
    signal input oracleKeyId;     // Poseidon(oracleAx, oracleAy) — pinned by the contract
    signal input threshold;       // minimum balance being proven (>=)
    signal input assetId;         // asset the balance is denominated in
    signal input currentTime;     // verifier-supplied current unix time
    signal input maxAgeSeconds;   // freshness window (attestation age must be <=)
    signal input holderBinding;   // Poseidon(BabyPbk(holderSk)) — binds proof to holder

    // ---- private ----
    signal input oracleAx;        // oracle BabyJubJub pubkey
    signal input oracleAy;
    signal input sigS;            // EdDSA signature (S, R8)
    signal input sigR8x;
    signal input sigR8y;
    signal input balance;         // the actual bank balance (hidden)
    signal input timestamp;       // when the oracle observed the balance (hidden)
    signal input holderSk;        // holder BabyJubJub private scalar

    // 1. Holder owns the subject: holderBinding = Poseidon(BabyPbk(holderSk)).
    component pbk = BabyPbk();
    pbk.in <== holderSk;
    component addr = Poseidon(2);
    addr.inputs[0] <== pbk.Ax;
    addr.inputs[1] <== pbk.Ay;
    addr.out === holderBinding;

    // 2. Oracle key id = Poseidon(oracleAx, oracleAy) (public → contract pins it).
    component ok = Poseidon(2);
    ok.inputs[0] <== oracleAx;
    ok.inputs[1] <== oracleAy;
    ok.out === oracleKeyId;

    // 3. The signed attestation message binds holder + balance + asset + time.
    component msg = Poseidon(4);
    msg.inputs[0] <== holderBinding;
    msg.inputs[1] <== balance;
    msg.inputs[2] <== assetId;
    msg.inputs[3] <== timestamp;

    // 4. Verify the oracle's EdDSA-Poseidon signature over the message.
    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1;
    sig.Ax  <== oracleAx;
    sig.Ay  <== oracleAy;
    sig.S   <== sigS;
    sig.R8x <== sigR8x;
    sig.R8y <== sigR8y;
    sig.M   <== msg.out;

    // 5. balance >= threshold. Bit-constrain BOTH comparands to 64 bits first
    //    (GreaterEqThan only range-checks the internal difference — feeding
    //    unconstrained inputs is the classic RangeProof alias footgun).
    component balBits = Num2Bits(64);
    balBits.in <== balance;
    component thrBits = Num2Bits(64);
    thrBits.in <== threshold;
    component ge = GreaterEqThan(64);
    ge.in[0] <== balance;
    ge.in[1] <== threshold;
    ge.out === 1;

    // 6. Freshness: timestamp <= currentTime AND (currentTime - timestamp) <= maxAgeSeconds.
    component tsBits = Num2Bits(64);
    tsBits.in <== timestamp;
    component nowBits = Num2Bits(64);
    nowBits.in <== currentTime;
    component notFuture = LessEqThan(64);
    notFuture.in[0] <== timestamp;
    notFuture.in[1] <== currentTime;
    notFuture.out === 1;

    // age = currentTime - timestamp is non-negative given notFuture; bound it.
    signal age;
    age <== currentTime - timestamp;
    component ageBits = Num2Bits(64);
    ageBits.in <== age;
    component fresh = LessEqThan(64);
    fresh.in[0] <== age;
    fresh.in[1] <== maxAgeSeconds;
    fresh.out === 1;
}
