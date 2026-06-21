pragma circom 2.2.2;

// Benzo org-note spend authorization (in-circuit M-of-N merge — stage 1+2 core).
//
// Proves an org note can be spent: (A) AUTHORIZATION — >=threshold DISTINCT org
// members each EdDSA-signed this transfer's spendMessage, members in orgMemberRoot;
// (B) OWNERSHIP/SOUNDNESS ANCHOR — the note's recipientPk == BenzoOrgNoteIdentity(
// orgMemberRoot, threshold, akGroupPub), so preimage resistance forces the M-of-N
// path and pins the group key; (C) NULLIFIER — nullifier == BenzoNullifier(nk_org,
// leafIndex) with nk_org = Poseidon2(akGroup, blinding), proving knowledge of the
// secret group key akGroup (akGroupPub = BenzoKeypair(akGroup)) and yielding a
// canonical, UNLINKABLE nullifier (per-note blinding => no org spend-graph leak).
//
// (C) is the fix to the adversarial finding that stage-1 had no nullifier logic and
// the live nk-derivation (from orgSpendId) is undefined for org notes. In the merged
// joinsplit_org, `blinding` + `leafIndex` are additionally pinned by the input note's
// commitment + pool Merkle membership, making the nullifier fully canonical.
//
// Public  : [orgMemberRoot, threshold, spendMessage, recipientPk, nullifier]
// Private : akGroup, blinding, leafIndex; per signer — enabled, BabyJubJub pubkey,
//           EdDSA sig, member Merkle path.

include "../lib/circomlib/circuits/eddsaposeidon.circom";
include "../lib/circomlib/circuits/poseidon.circom";
include "../lib/circomlib/circuits/comparators.circom";
include "../lib/merkleProof.circom";
include "./note.circom";

template OrgNoteSpend(levels, maxSigners) {
    // ---- public ----
    signal input orgMemberRoot;
    signal input threshold;
    signal input spendMessage;
    signal input recipientPk;   // the org note's recipient_pk (binds this spend to the note)
    signal input nullifier;     // the spent note's canonical nullifier

    // ---- private: group key + note secrets ----
    signal input akGroup;       // the org's secret group key (held by the quorum, NOT the viewing key)
    signal input blinding;      // the spent note's blinding (per-note secret => unlinkable nullifier)
    signal input leafIndex;     // the spent note's pool leaf index

    // ---- private, per signer slot ----
    signal input enabled[maxSigners];
    signal input Ax[maxSigners];
    signal input Ay[maxSigners];
    signal input S[maxSigners];
    signal input R8x[maxSigners];
    signal input R8y[maxSigners];
    signal input pathElements[maxSigners][levels];
    signal input pathIndices[maxSigners];

    // ---- M-of-N over the org member set ----
    signal keyId[maxSigners];
    component ik[maxSigners];
    component sig[maxSigners];
    component tree[maxSigners];
    for (var i = 0; i < maxSigners; i++) {
        enabled[i] * (enabled[i] - 1) === 0;
        ik[i] = Poseidon(2);
        ik[i].inputs[0] <== Ax[i];
        ik[i].inputs[1] <== Ay[i];
        keyId[i] <== ik[i].out;
        sig[i] = EdDSAPoseidonVerifier();
        sig[i].enabled <== enabled[i];
        sig[i].Ax  <== Ax[i];
        sig[i].Ay  <== Ay[i];
        sig[i].S   <== S[i];
        sig[i].R8x <== R8x[i];
        sig[i].R8y <== R8y[i];
        sig[i].M   <== spendMessage;
        tree[i] = MerkleProof(levels);
        tree[i].leaf <== keyId[i];
        tree[i].pathIndices <== pathIndices[i];
        for (var j = 0; j < levels; j++) { tree[i].pathElements[j] <== pathElements[i][j]; }
        enabled[i] * (tree[i].root - orgMemberRoot) === 0;
    }
    component eq[maxSigners][maxSigners];
    signal both[maxSigners][maxSigners];
    for (var i = 0; i < maxSigners; i++) {
        for (var j = 0; j < maxSigners; j++) {
            if (j > i) {
                eq[i][j] = IsEqual();
                eq[i][j].in[0] <== keyId[i];
                eq[i][j].in[1] <== keyId[j];
                both[i][j] <== enabled[i] * enabled[j];
                both[i][j] * eq[i][j].out === 0;
            } else {
                both[i][j] <== 0;
            }
        }
    }
    var sum = 0;
    for (var i = 0; i < maxSigners; i++) { sum += enabled[i]; }
    signal count;
    count <== sum;
    component ge = GreaterEqThan(8);
    ge.in[0] <== count;
    ge.in[1] <== threshold;
    ge.out === 1;

    // ---- group key: akGroupPub = BenzoKeypair(akGroup) (knowledge of akGroup) ----
    component gk = BenzoKeypair();
    gk.ak <== akGroup;

    // ---- SOUNDNESS ANCHOR: recipientPk == Poseidon2(orgMemberRoot, threshold, akGroupPub).
    // Pins the member set, the threshold, AND the group key — the merged joinsplit
    // compares this to the input note's recipient_pk. ----
    component id = BenzoOrgNoteIdentity();
    id.orgMemberRoot <== orgMemberRoot;
    id.threshold <== threshold;
    id.akGroupPub <== gk.publicKey;
    id.out === recipientPk;

    // ---- NULLIFIER: nk_org = Poseidon2(akGroup, blinding); nullifier = Poseidon2(nk_org, leafIndex).
    // Canonical (akGroup pinned by recipientPk; blinding + leafIndex pinned by the note
    // commitment + Merkle membership in the merge) and unlinkable (per-note blinding). ----
    component nk = BenzoOrgNullifierKey();
    nk.akGroup <== akGroup;
    nk.blinding <== blinding;
    component nf = BenzoNullifier();
    nf.nk <== nk.nkOrg;
    nf.leafIndex <== leafIndex;
    nf.out === nullifier;
}
