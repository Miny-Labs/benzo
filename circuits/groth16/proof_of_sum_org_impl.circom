pragma circom 2.2.2;

// Benzo ORG proof-of-sum / confidential disclose-total over an M-of-N TREASURY.
//
// Proves: "the org (which knows memberRoot, threshold, and the group key akGroup)
// owns up to `nNotes` ORG notes in the pool Merkle tree whose amounts sum to
// EXACTLY `claimedTotal`" — revealing only the total, never the individual
// salaries/amounts, the note count, or which leaves they are.
//
// This is the org analog of ProofOfSum. The single-key SUM circuit derives the
// owner from one spend key (BenzoKeypair); here the owner is the org-note
// identity Poseidon2(memberRoot, threshold, akGroupPub; ORG_NOTE_DOMAIN) — the
// same preimage-bound owner every org treasury note is created under. So an
// auditor learns the cryptographically verified treasury total and nothing else,
// without the org ever revealing a member key, a spend key, or any one amount.
//
// Public  : root, claimedTotal, assetId, context
// Private : orgMemberRoot, threshold, akGroup, and per slot
//           { amount, blinding, pathIndices, pathElements }
//
// Sum-correctness: every amount is 64-bit range-checked so the running sum cannot
// wrap mod p before the equality; claimedTotal === sum binds the revealed total
// to the owned notes. Padding slots use amount 0 with the membership check
// disabled (ForceEqualIfEnabled) and contribute 0.

include "./note.circom";
include "../lib/merkleProof.circom";
include "../lib/circomlib/circuits/comparators.circom";

template ProofOfSumOrg(levels, nNotes) {
    // ---- public ----
    signal input root;         // a recent pool Merkle root
    signal input claimedTotal; // the disclosed treasury total (the only revealed figure)
    signal input assetId;      // asset domain (USDC SAC)
    signal input context;      // verifier-chosen binding (auditor/scope nonce)

    // ---- private ----
    signal input orgMemberRoot; // the org's member-set Merkle root
    signal input threshold;     // M (fixed at note creation; not revealed)
    signal input akGroup;       // the secret group spend-auth key
    signal input amount[nNotes];
    signal input blinding[nNotes];
    signal input pathIndices[nNotes];
    signal input pathElements[nNotes][levels];

    // Bind `context` into the constraint system (replay protection per disclosure).
    signal contextSq;
    contextSq <== context * context;

    // Org owner: recipientPk = Poseidon2(memberRoot, threshold, akGroupPub; ORG),
    // akGroupPub = Poseidon2(akGroup, 0; KEYPAIR). Knowing this preimage is the
    // org's read/ownership proof for a disclosure (no member signatures needed —
    // this is not a spend, so no M-of-N gadget, just owner knowledge).
    component akpub = BenzoKeypair();
    akpub.ak <== akGroup;
    component owner = BenzoOrgNoteIdentity();
    owner.orgMemberRoot <== orgMemberRoot;
    owner.threshold     <== threshold;
    owner.akGroupPub    <== akpub.publicKey;

    component range[nNotes];
    component commit[nNotes];
    component tree[nNotes];
    component checkRoot[nNotes];

    var sum = 0;
    for (var i = 0; i < nNotes; i++) {
        // 64-bit range so the running sum cannot overflow the field.
        range[i] = AmountCheck();
        range[i].amount <== amount[i];

        // commitment = Poseidon2(amount, orgPk, blinding, assetId)
        commit[i] = BenzoNoteCommitment();
        commit[i].amount      <== amount[i];
        commit[i].recipientPk <== owner.out;
        commit[i].blinding    <== blinding[i];
        commit[i].assetId     <== assetId;

        // Merkle membership to the public root (disabled for amount-0 padding).
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

    // Exact total: the revealed claimedTotal equals the sum of the owned org notes.
    claimedTotal === sum;
}
