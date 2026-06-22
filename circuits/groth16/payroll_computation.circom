pragma circom 2.2.2;

// Benzo verifiable payroll computation (Z6): prove the run total AND every per-
// line note commitment were CORRECTLY DERIVED from the rate card —
//   gross_i = rate_i * period_i - deductions_i,   runTotal = Σ gross_i
// — with the RATE CARD (rates, periods, deductions) kept PRIVATE. The total is
// computed-not-asserted: the chain accepts it only if it equals the sum of the
// hidden per-line grosses, and each settled note commits to exactly that gross.
//
// `commitDigest` = Poseidon2 over the per-line note commitments binds the proof
// to the actual notes that settle (the SDK recomputes the same digest from the
// on-chain commitments). Disabled slots use rate=period=deductions=0 ⇒ gross 0.
//
// Public  : runTotal, assetId, context, commitDigest
// Private : per line { rate, period, deductions, recipientPk, blinding }

include "./note.circom";
include "../lib/poseidon2/poseidon2_hash.circom";

function PAYROLL_DIGEST_DOMAIN() { return 0x0b; }

template PayrollComputation(nLines) {
    // ---- public ----
    signal input runTotal;     // the disclosed run total (computed, not asserted)
    signal input assetId;      // asset domain (USDC SAC)
    signal input context;      // verifier/run binding (replay protection)
    signal input commitDigest; // Poseidon2 over the nLines note commitments

    // ---- private (the rate card) ----
    signal input rate[nLines];
    signal input period[nLines];
    signal input deductions[nLines];
    signal input recipientPk[nLines];
    signal input blinding[nLines];

    // Bind `context` into the constraint system (replay protection).
    signal contextSq;
    contextSq <== context * context;

    signal rp[nLines];
    signal gross[nLines];
    component grossRange[nLines];
    component commit[nLines];

    var sum = 0;
    for (var i = 0; i < nLines; i++) {
        // gross = rate * period - deductions (one multiplication per line)
        rp[i] <== rate[i] * period[i];
        gross[i] <== rp[i] - deductions[i];

        // gross is a well-formed 64-bit value (also forbids negative gross:
        // if deductions > rate*period the field-wrapped value fails Num2Bits).
        grossRange[i] = AmountCheck();
        grossRange[i].amount <== gross[i];

        // the per-line note commits to exactly the computed gross
        commit[i] = BenzoNoteCommitment();
        commit[i].amount      <== gross[i];
        commit[i].recipientPk <== recipientPk[i];
        commit[i].blinding    <== blinding[i];
        commit[i].assetId     <== assetId;

        sum += gross[i];
    }

    // run total is the SUM of the hidden grosses (computed, not asserted)
    sum === runTotal;

    // digest binds all line commitments to this proof. Poseidon2 is parameterized
    // for t<=4 only, so fold the 4 commitments through binary Poseidon2(2) hashes:
    //   digest = H( H(c0,c1), H(c2,c3) ).
    component h01 = Poseidon2(2);
    h01.inputs[0] <== commit[0].out;
    h01.inputs[1] <== commit[1].out;
    h01.domainSeparation <== PAYROLL_DIGEST_DOMAIN();
    component h23 = Poseidon2(2);
    h23.inputs[0] <== commit[2].out;
    h23.inputs[1] <== commit[3].out;
    h23.domainSeparation <== PAYROLL_DIGEST_DOMAIN();
    component dig = Poseidon2(2);
    dig.inputs[0] <== h01.out;
    dig.inputs[1] <== h23.out;
    dig.domainSeparation <== PAYROLL_DIGEST_DOMAIN();
    dig.out === commitDigest;
}

component main {public [runTotal, assetId, context, commitDigest]} = PayrollComputation(4);
