pragma circom 2.2.2;

// Benzo cross-entity private netting (Z8).
//
// Two orgs hold mutual inter-company invoices: A owes B `aOwesB`, B owes A
// `bOwesA`. Instead of two gross settlements, they settle ONLY the net
// difference. This proves the net was computed correctly —
//   net = |aOwesB - bOwesA|, paid by whoever owes more —
// WITHOUT revealing either gross amount. Only `net` and the payer direction are
// public; the two invoice totals stay private to each party.
//
// AmountCheck on the SELECTED net (a 64-bit non-negativity range check) also
// enforces direction correctness: if `payerIsA` is wrong, the selected
// difference underflows the field and the range check fails — unprovable.
//
// Public  : net, payerIsA, context
// Private : aOwesB, bOwesA

include "./note.circom"; // AmountCheck (64-bit range)

template CrossNetting() {
    // ---- public ----
    signal input net;      // the settled net difference (paid by the larger debtor)
    signal input payerIsA; // 1 if A pays B (A owes more), 0 if B pays A
    signal input context;  // verifier/settlement binding (replay protection)

    // ---- private ----
    signal input aOwesB;   // A's invoice total to B (NEVER revealed)
    signal input bOwesA;   // B's invoice total to A (NEVER revealed)

    // Bind `context` into the constraint system (replay protection).
    signal contextSq;
    contextSq <== context * context;

    // payerIsA is a bit.
    payerIsA * (payerIsA - 1) === 0;

    // both gross amounts are well-formed 64-bit values.
    component rA = AmountCheck();
    rA.amount <== aOwesB;
    component rB = AmountCheck();
    rB.amount <== bOwesA;

    // candidate nets in each direction (one of these is the field-wrapped negative).
    signal netA;
    netA <== aOwesB - bOwesA; // valid (>=0) only when A owes more
    signal netB;
    netB <== bOwesA - aOwesB; // valid (>=0) only when B owes more

    // select the net for the stated payer direction.
    signal paNetA;
    paNetA <== payerIsA * netA;
    signal oneMinus;
    oneMinus <== 1 - payerIsA;
    signal pbNetB;
    pbNetB <== oneMinus * netB;
    signal selected;
    selected <== paNetA + pbNetB;

    // the public net must equal the selected difference ...
    net === selected;
    // ... and be a non-negative 64-bit value. This range check is what forbids a
    // wrong direction (the underflowed difference is a huge field element).
    component rNet = AmountCheck();
    rNet.amount <== net;
}

component main {public [net, payerIsA, context]} = CrossNetting();
