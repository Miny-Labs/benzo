pragma circom 2.2.2;

// TRANSFER / join-split WITH in-circuit M-of-N org dual-control (2-in / 2-out).
//
// A COPY of joinsplit_impl.circom (the live transfer circuit is left byte-for-byte
// untouched) with one addition: a per-input spend-authority SELECTOR forced by the
// note's recipient_pk. For each input:
//   - CONSUMER note (recipientPk = BenzoKeypair(ak)): spent by knowledge of `ak`,
//     nullifier from the single-key nk — exactly as the live circuit.
//   - ORG note (recipientPk = BenzoOrgNoteIdentity(orgMemberRoot, threshold, akGroupPub)):
//     spent ONLY via >=threshold DISTINCT member EdDSA sigs over this transfer's
//     spendMessage (members in orgMemberRoot), proving knowledge of the group key
//     akGroup, with a canonical UNLINKABLE nullifier (nk_org = Poseidon2(akGroup,
//     blinding)). See OrgInputAuth + note.circom (BenzoOrgNoteIdentity/BenzoOrgNullifierKey).
//
// Soundness of the selector (no separate forgeable flag): the recipPk Mux makes
// recipPk == orgPk IFF inIsOrg=1, and recipPk feeds the input commitment that is
// Merkle-proven in the pool root — so the note's ACTUAL recipient_pk decides the
// only feasible path (0x03 vs 0x09 domains make a consumer/org recipientPk collision
// a Poseidon2 preimage). The org M-of-N machinery is gated by eEn = inIsOrg*enabled,
// so it is fully vacuous for consumer inputs.
//
// PRIVACY: orgMemberRoot/threshold are PRIVATE (bound only via recipientPk) — they
// are NOT public inputs, so an on-chain observer cannot tell which org spent, and the
// per-note blinding keeps the org's nullifiers mutually unlinkable.
//
// Public-input vector is IDENTICAL to the live joinsplit (the Soroban transfer_org
// entry mirrors the audited push order).

include "./note.circom";
include "../lib/merkleProof.circom";
include "../lib/circomlib/circuits/comparators.circom";
include "../lib/circomlib/circuits/poseidon.circom";
include "../lib/circomlib/circuits/eddsaposeidon.circom";

// Per-input org authorization: outputs the org recipientPk + canonical org nullifier,
// and (gated by isOrg) enforces M-of-N over the org member set.
template OrgInputAuth(memberLevels, maxSigners) {
    signal input isOrg;            // boolean
    signal input orgMemberRoot;
    signal input threshold;
    signal input akGroup;          // secret group key (held by the quorum)
    signal input blinding;         // the input note's blinding (pins the nullifier)
    signal input leafIndex;
    signal input spendMessage;     // = H(input nullifiers, output commitments)
    signal input enabled[maxSigners];
    signal input Ax[maxSigners];
    signal input Ay[maxSigners];
    signal input S[maxSigners];
    signal input R8x[maxSigners];
    signal input R8y[maxSigners];
    signal input pathElements[maxSigners][memberLevels];
    signal input pathIndices[maxSigners];
    signal output orgPk;
    signal output orgNullifier;

    isOrg * (isOrg - 1) === 0;

    // group identity: orgPk = Poseidon2(orgMemberRoot, threshold, BenzoKeypair(akGroup))
    component gk = BenzoKeypair();
    gk.ak <== akGroup;
    component id = BenzoOrgNoteIdentity();
    id.orgMemberRoot <== orgMemberRoot;
    id.threshold <== threshold;
    id.akGroupPub <== gk.publicKey;
    orgPk <== id.out;

    // canonical, unlinkable nullifier: nk_org = Poseidon2(akGroup, blinding)
    component nk = BenzoOrgNullifierKey();
    nk.akGroup <== akGroup;
    nk.blinding <== blinding;
    component nf = BenzoNullifier();
    nf.nk <== nk.nkOrg;
    nf.leafIndex <== leafIndex;
    orgNullifier <== nf.out;

    // M-of-N, gated by isOrg (eEn=0 for consumer inputs => fully vacuous)
    signal eEn[maxSigners];
    signal keyId[maxSigners];
    component ik[maxSigners];
    component sig[maxSigners];
    component tree[maxSigners];
    for (var i = 0; i < maxSigners; i++) {
        enabled[i] * (enabled[i] - 1) === 0;
        eEn[i] <== isOrg * enabled[i];
        ik[i] = Poseidon(2);
        ik[i].inputs[0] <== Ax[i];
        ik[i].inputs[1] <== Ay[i];
        keyId[i] <== ik[i].out;
        sig[i] = EdDSAPoseidonVerifier();
        sig[i].enabled <== eEn[i];
        sig[i].Ax  <== Ax[i];
        sig[i].Ay  <== Ay[i];
        sig[i].S   <== S[i];
        sig[i].R8x <== R8x[i];
        sig[i].R8y <== R8y[i];
        sig[i].M   <== spendMessage;
        tree[i] = MerkleProof(memberLevels);
        tree[i].leaf <== keyId[i];
        tree[i].pathIndices <== pathIndices[i];
        for (var j = 0; j < memberLevels; j++) { tree[i].pathElements[j] <== pathElements[i][j]; }
        eEn[i] * (tree[i].root - orgMemberRoot) === 0;
    }
    component eq[maxSigners][maxSigners];
    signal both[maxSigners][maxSigners];
    for (var i = 0; i < maxSigners; i++) {
        for (var j = 0; j < maxSigners; j++) {
            if (j > i) {
                eq[i][j] = IsEqual();
                eq[i][j].in[0] <== keyId[i];
                eq[i][j].in[1] <== keyId[j];
                both[i][j] <== eEn[i] * eEn[j];
                both[i][j] * eq[i][j].out === 0;
            } else {
                both[i][j] <== 0;
            }
        }
    }
    var sum = 0;
    for (var i = 0; i < maxSigners; i++) { sum += eEn[i]; }
    signal count;
    count <== sum;
    signal reqThreshold;
    reqThreshold <== isOrg * threshold;     // when isOrg=0, required count is 0 (vacuous)
    component ge = GreaterEqThan(8);
    ge.in[0] <== count;
    ge.in[1] <== reqThreshold;
    ge.out === 1;
}

template JoinSplitOrg(levels, mvkLevels) {
    var nIns = 2;
    var nOuts = 2;
    var memberLevels = 16;
    var maxSigners = 3;

    /** PUBLIC INPUTS (order IDENTICAL to the live joinsplit) **/
    signal input root;
    signal input assetId;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];
    signal input fee;
    signal input extDataHash;
    signal input mvkTag[nOuts];
    signal input registeredMvkRoot;

    /** PRIVATE INPUTS (consumer path, same as live) **/
    signal input inAmount[nIns];
    signal input inOrgSpendId[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];
    signal input outMvkPub[nOuts];
    signal input mvkKeyMeta[nOuts];
    signal input mvkPathElements[nOuts][mvkLevels];
    signal input mvkPathIndices[nOuts];

    /** PRIVATE INPUTS (org path; per input) **/
    signal input inIsOrg[nIns];
    signal input orgMemberRoot[nIns];
    signal input orgThreshold[nIns];
    signal input akGroup[nIns];
    signal input mEnabled[nIns][maxSigners];
    signal input mAx[nIns][maxSigners];
    signal input mAy[nIns][maxSigners];
    signal input mS[nIns][maxSigners];
    signal input mR8x[nIns][maxSigners];
    signal input mR8y[nIns][maxSigners];
    signal input mPathElements[nIns][maxSigners][memberLevels];
    signal input mPathIndices[nIns][maxSigners];

    // spendMessage = H(input nullifiers, output commitments) — what each org member
    // signs; binds the M-of-N approval to THIS transfer's spend tuple.
    component spendMsg = Poseidon(4);
    spendMsg.inputs[0] <== inputNullifier[0];
    spendMsg.inputs[1] <== inputNullifier[1];
    spendMsg.inputs[2] <== outputCommitment[0];
    spendMsg.inputs[3] <== outputCommitment[1];

    component inSpendKeys[nIns];
    component inKeypair[nIns];
    component inCommitment[nIns];
    component inNullifier[nIns];   // consumer-path nullifier
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inRange[nIns];
    component orgAuth[nIns];
    signal recipPk[nIns];
    signal selOrgPk[nIns];
    signal nullSel[nIns];
    signal selOrgNull[nIns];

    var sumIns = 0;
    for (var tx = 0; tx < nIns; tx++) {
        inRange[tx] = AmountCheck();
        inRange[tx].amount <== inAmount[tx];

        // consumer (single-key) candidate
        inSpendKeys[tx] = BenzoSpendKeys();
        inSpendKeys[tx].orgSpendId <== inOrgSpendId[tx];
        inKeypair[tx] = BenzoKeypair();
        inKeypair[tx].ak <== inSpendKeys[tx].ak;

        // org candidate (+ gated M-of-N)
        orgAuth[tx] = OrgInputAuth(memberLevels, maxSigners);
        orgAuth[tx].isOrg <== inIsOrg[tx];
        orgAuth[tx].orgMemberRoot <== orgMemberRoot[tx];
        orgAuth[tx].threshold <== orgThreshold[tx];
        orgAuth[tx].akGroup <== akGroup[tx];
        orgAuth[tx].blinding <== inBlinding[tx];
        orgAuth[tx].leafIndex <== inPathIndices[tx];
        orgAuth[tx].spendMessage <== spendMsg.out;
        for (var i = 0; i < maxSigners; i++) {
            orgAuth[tx].enabled[i] <== mEnabled[tx][i];
            orgAuth[tx].Ax[i] <== mAx[tx][i];
            orgAuth[tx].Ay[i] <== mAy[tx][i];
            orgAuth[tx].S[i] <== mS[tx][i];
            orgAuth[tx].R8x[i] <== mR8x[tx][i];
            orgAuth[tx].R8y[i] <== mR8y[tx][i];
            orgAuth[tx].pathIndices[i] <== mPathIndices[tx][i];
            for (var j = 0; j < memberLevels; j++) { orgAuth[tx].pathElements[i][j] <== mPathElements[tx][i][j]; }
        }

        // SELECTOR: recipPk = consumerPk + isOrg*(orgPk - consumerPk) (Mux1)
        selOrgPk[tx] <== inIsOrg[tx] * (orgAuth[tx].orgPk - inKeypair[tx].publicKey);
        recipPk[tx] <== inKeypair[tx].publicKey + selOrgPk[tx];

        inCommitment[tx] = BenzoNoteCommitment();
        inCommitment[tx].amount      <== inAmount[tx];
        inCommitment[tx].recipientPk <== recipPk[tx];
        inCommitment[tx].blinding    <== inBlinding[tx];
        inCommitment[tx].assetId     <== assetId;

        // consumer-path nullifier candidate
        inNullifier[tx] = BenzoNullifier();
        inNullifier[tx].nk        <== inSpendKeys[tx].nk;
        inNullifier[tx].leafIndex <== inPathIndices[tx];

        // SELECTOR: nullifier = consumerNull + isOrg*(orgNull - consumerNull) (Mux1)
        selOrgNull[tx] <== inIsOrg[tx] * (orgAuth[tx].orgNullifier - inNullifier[tx].out);
        nullSel[tx] <== inNullifier[tx].out + selOrgNull[tx];
        nullSel[tx] === inputNullifier[tx];

        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf        <== inCommitment[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) {
            inTree[tx].pathElements[i] <== inPathElements[tx][i];
        }

        inCheckRoot[tx] = ForceEqualIfEnabled();
        inCheckRoot[tx].in[0]   <== root;
        inCheckRoot[tx].in[1]   <== inTree[tx].root;
        inCheckRoot[tx].enabled <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    component outCommitment[nOuts];
    component outRange[nOuts];
    component outTag[nOuts];
    component outMvkIsZero[nOuts];
    component outMvkLeaf[nOuts];
    component outMvkReg[nOuts];

    var sumOuts = 0;
    for (var tx = 0; tx < nOuts; tx++) {
        outCommitment[tx] = BenzoNoteCommitment();
        outCommitment[tx].amount      <== outAmount[tx];
        outCommitment[tx].recipientPk <== outPubkey[tx];
        outCommitment[tx].blinding    <== outBlinding[tx];
        outCommitment[tx].assetId     <== assetId;
        outCommitment[tx].out === outputCommitment[tx];

        outRange[tx] = AmountCheck();
        outRange[tx].amount <== outAmount[tx];

        outTag[tx] = BenzoMvkTag();
        outTag[tx].mvkPub   <== outMvkPub[tx];
        outTag[tx].blinding <== outBlinding[tx];
        outTag[tx].out === mvkTag[tx];

        outMvkIsZero[tx] = IsZero();
        outMvkIsZero[tx].in <== outMvkPub[tx];
        outMvkIsZero[tx].out === 0;
        outMvkLeaf[tx] = BenzoMvkRegistryLeaf();
        outMvkLeaf[tx].mvkPub  <== outMvkPub[tx];
        outMvkLeaf[tx].keyMeta <== mvkKeyMeta[tx];
        outMvkReg[tx] = MerkleProof(mvkLevels);
        outMvkReg[tx].leaf        <== outMvkLeaf[tx].out;
        outMvkReg[tx].pathIndices <== mvkPathIndices[tx];
        for (var i = 0; i < mvkLevels; i++) {
            outMvkReg[tx].pathElements[i] <== mvkPathElements[tx][i];
        }
        outMvkReg[tx].root === registeredMvkRoot;

        sumOuts += outAmount[tx];
    }

    // Distinct nullifiers.
    component sameNullifier = IsEqual();
    sameNullifier.in[0] <== inputNullifier[0];
    sameNullifier.in[1] <== inputNullifier[1];
    sameNullifier.out === 0;

    // Fee range check, then value conservation.
    component feeRange = AmountCheck();
    feeRange.amount <== fee;
    sumIns === sumOuts + fee;

    // Bind extDataHash into the proof.
    signal extDataSquare <== extDataHash * extDataHash;
}
