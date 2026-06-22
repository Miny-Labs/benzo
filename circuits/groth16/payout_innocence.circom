pragma circom 2.2.2;

// Benzo per-payout proof-of-innocence (Z4): prove the RECIPIENT of a payout is
// NOT on a sanctions / deny set (an OFAC-style deny SMT), WITHOUT revealing who
// the recipient is. The org screens every payout against the regulator's deny
// list cryptographically — a sanctioned recipient cannot be proven innocent, so
// the payout is provably blocked.
//
// Binds to the SPECIFIC payout via its public note commitment (the same
// commitment that lands on-chain when the payout settles): a verifier confirms
// the commitment is a real on-chain payout, and the proof attests its recipient
// is absent from the deny set keyed `recipientPk`.
//
// Public  : denyRoot, commitment, assetId, context
// Private : amount, blinding, recipientPk, smt{Siblings,OldKey,OldValue,IsOld0}

include "./note.circom";
include "../lib/smt/smtverifier.circom";
include "../lib/circomlib/circuits/bitify.circom";

template PayoutInnocence(smtLevels) {
    // ---- public ----
    signal input denyRoot;   // root of the sanctions / deny SMT (keyed by recipientPk)
    signal input commitment; // the on-chain payout note commitment this proof is about
    signal input assetId;    // asset domain (USDC SAC)
    signal input context;    // verifier/payout binding (replay protection)

    // ---- private ----
    signal input amount;      // payout amount (NEVER revealed)
    signal input blinding;    // note blinding
    signal input recipientPk; // payout recipient pk (NEVER revealed)
    signal input smtSiblings[smtLevels];
    signal input smtOldKey;
    signal input smtOldValue;
    signal input smtIsOld0;

    // Bind `context` into the constraint system (replay protection).
    signal contextSq;
    contextSq <== context * context;

    // The opened note must equal the public commitment (binds proof to THIS payout).
    component cm = BenzoNoteCommitment();
    cm.amount      <== amount;
    cm.recipientPk <== recipientPk;
    cm.blinding    <== blinding;
    cm.assetId     <== assetId;
    cm.out === commitment;

    // Proof-of-innocence: recipientPk is NOT in the deny SMT.
    component poi = SMTVerifier(smtLevels);
    poi.enabled <== 1;
    poi.root    <== denyRoot;
    for (var i = 0; i < smtLevels; i++) {
        poi.siblings[i] <== smtSiblings[i];
    }
    poi.oldKey   <== smtOldKey;
    poi.oldValue <== smtOldValue;
    component old0 = Num2Bits(1);
    old0.in <== smtIsOld0;
    poi.isOld0 <== old0.out[0];
    poi.key   <== recipientPk;
    poi.value <== recipientPk; // unused for non-inclusion; key presence is checked
    poi.fnc   <== 1;           // 1 = verify NON-inclusion
}

component main {public [denyRoot, commitment, assetId, context]} = PayoutInnocence(16);
