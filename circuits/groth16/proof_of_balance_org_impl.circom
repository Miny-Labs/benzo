pragma circom 2.2.2;

// Benzo ORG proof-of-balance / proof-of-funds over an M-of-N TREASURY.
//
// Proves: "the org (which knows memberRoot, threshold, akGroup) owns up to
// `nNotes` ORG notes in the pool tree whose amounts sum to AT LEAST `minTotal`"
// — without revealing the balance, the note count, or which leaves. The org
// analog of ProofOfBalance: the owner is the org-note identity
// Poseidon2(memberRoot, threshold, akGroupPub; ORG_NOTE_DOMAIN), not a single key.
//
// Powers: "Payroll funded ✓" (minTotal = the run total), treasury reserves to a
// lender (minTotal = covenant), and true solvency (minTotal = Σ liabilities).
//
// Public  : root, minTotal, assetId, context
// Private : orgMemberRoot, orgThreshold, akGroup, and per slot
//           { amount, blinding, pathIndices, pathElements }

include "./note.circom";
include "../lib/merkleProof.circom";
include "../lib/circomlib/circuits/comparators.circom";

template ProofOfBalanceOrg(levels, nNotes) {
    // ---- public ----
    signal input root;      // a recent pool Merkle root
    signal input minTotal;  // the floor being proven (run total / covenant / liabilities)
    signal input assetId;   // asset domain (USDC SAC)
    signal input context;   // verifier-chosen binding (request nonce)

    // ---- private ----
    signal input orgMemberRoot;
    signal input orgThreshold; // the org's M (note: distinct from the balance `minTotal`)
    signal input akGroup;
    signal input amount[nNotes];
    signal input blinding[nNotes];
    signal input pathIndices[nNotes];
    signal input pathElements[nNotes][levels];

    // Bind `context` into the constraint system (replay protection).
    signal contextSq;
    contextSq <== context * context;

    // Org owner: recipientPk = Poseidon2(memberRoot, threshold, akGroupPub; ORG).
    component akpub = BenzoKeypair();
    akpub.ak <== akGroup;
    component owner = BenzoOrgNoteIdentity();
    owner.orgMemberRoot <== orgMemberRoot;
    owner.threshold     <== orgThreshold;
    owner.akGroupPub    <== akpub.publicKey;

    component range[nNotes];
    component commit[nNotes];
    component tree[nNotes];
    component checkRoot[nNotes];

    var sum = 0;
    for (var i = 0; i < nNotes; i++) {
        range[i] = AmountCheck();
        range[i].amount <== amount[i];

        commit[i] = BenzoNoteCommitment();
        commit[i].amount      <== amount[i];
        commit[i].recipientPk <== owner.out;
        commit[i].blinding    <== blinding[i];
        commit[i].assetId     <== assetId;

        tree[i] = MerkleProof(levels);
        tree[i].leaf        <== commit[i].out;
        tree[i].pathIndices <== pathIndices[i];
        for (var j = 0; j < levels; j++) {
            tree[i].pathElements[j] <== pathElements[i][j];
        }
        checkRoot[i] = ForceEqualIfEnabled();
        checkRoot[i].in[0]   <== root;
        checkRoot[i].in[1]   <== tree[i].root;
        checkRoot[i].enabled <== amount[i];

        sum += amount[i];
    }

    // sum >= minTotal. Amounts are 64-bit, nNotes <= 8 → sum < 2^67; 70 bits covers it.
    component geq = GreaterEqThan(70);
    geq.in[0] <== sum;
    geq.in[1] <== minTotal;
    geq.out === 1;
}
