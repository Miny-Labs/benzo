pragma circom 2.2.2;

// Benzo in-ZK spending policy (Z3): prove a single payout is WITHIN an approved
// per-payout cap, WITHOUT revealing the payout amount.
//
// The spending limit becomes a circuit constraint. The proof binds to the
// SPECIFIC payout via its public note commitment (the same commitment that lands
// on-chain when the payout settles), so a verifier can (1) confirm the commitment
// is a real on-chain payout note, and (2) trust the proof that amount <= cap —
// while the amount itself stays hidden.
//
// Public  : commitment, cap, assetId, context
// Private : amount, blinding, recipientPk

include "./note.circom";
include "../lib/circomlib/circuits/comparators.circom";

template SpendingCap() {
    // ---- public ----
    signal input commitment; // the on-chain payout note commitment this proof is about
    signal input cap;        // the approved per-payout ceiling (policy limit)
    signal input assetId;    // asset domain (USDC SAC)
    signal input context;    // verifier/payout binding (replay protection)

    // ---- private ----
    signal input amount;      // the payout amount (NEVER revealed)
    signal input blinding;    // note blinding
    signal input recipientPk; // payout recipient pk

    // Bind `context` into the constraint system (replay protection).
    signal contextSq;
    contextSq <== context * context;

    // amount is a well-formed 64-bit value.
    component range = AmountCheck();
    range.amount <== amount;

    // The opened note must equal the public commitment (binds proof to THIS payout).
    component commit = BenzoNoteCommitment();
    commit.amount      <== amount;
    commit.recipientPk <== recipientPk;
    commit.blinding    <== blinding;
    commit.assetId     <== assetId;
    commit.out === commitment;

    // The spending policy itself: amount <= cap. Both are < 2^64, so 64 bits covers it.
    component leq = LessEqThan(64);
    leq.in[0] <== amount;
    leq.in[1] <== cap;
    leq.out === 1;
}

component main {public [commitment, cap, assetId, context]} = SpendingCap();
