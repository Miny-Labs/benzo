pragma circom 2.2.2;

// Benzo in-circuit M-of-N org spend authorization.
//
// Proves, in zero knowledge, that at least `threshold` DISTINCT members of an
// org — whose member key-ids form `orgMemberRoot` — each EdDSA-signed the SAME
// `spendMessage`. Composed into a shielded spend, this makes M-of-N dual-control
// a property of the PROOF itself (not an off-chain checker and not a single
// in-circuit scalar): the chain accepts the spend only if the threshold of real
// member signatures is present. The consumer "org of one" is the degenerate
// N=1/threshold=1 case.
//
// Public  : [orgMemberRoot, threshold, spendMessage, authTag]
// Private : per signer slot — enabled flag, BabyJubJub pubkey, EdDSA signature,
//           and the member's Merkle path. Disabled slots are no-ops.

include "../lib/circomlib/circuits/eddsaposeidon.circom";
include "../lib/circomlib/circuits/poseidon.circom";
include "../lib/circomlib/circuits/comparators.circom";
include "../lib/merkleProof.circom";

template OrgSpendAuth(levels, maxSigners) {
    // ---- public ----
    signal input orgMemberRoot;  // Merkle root of member key-ids = Poseidon(Ax, Ay)
    signal input threshold;      // required distinct approvals (M)
    signal input spendMessage;   // the spend binding every member signs (e.g. transfer hash)
    signal input authTag;        // output: Poseidon(spendMessage, orgMemberRoot)

    // ---- private, per signer slot ----
    signal input enabled[maxSigners];
    signal input Ax[maxSigners];
    signal input Ay[maxSigners];
    signal input S[maxSigners];
    signal input R8x[maxSigners];
    signal input R8y[maxSigners];
    signal input pathElements[maxSigners][levels];
    signal input pathIndices[maxSigners];

    signal keyId[maxSigners];
    component ik[maxSigners];
    component sig[maxSigners];
    component tree[maxSigners];

    for (var i = 0; i < maxSigners; i++) {
        // enabled is boolean
        enabled[i] * (enabled[i] - 1) === 0;

        // member key-id = Poseidon(Ax, Ay)
        ik[i] = Poseidon(2);
        ik[i].inputs[0] <== Ax[i];
        ik[i].inputs[1] <== Ay[i];
        keyId[i] <== ik[i].out;

        // verify EdDSA over the shared spendMessage (skipped when disabled)
        sig[i] = EdDSAPoseidonVerifier();
        sig[i].enabled <== enabled[i];
        sig[i].Ax  <== Ax[i];
        sig[i].Ay  <== Ay[i];
        sig[i].S   <== S[i];
        sig[i].R8x <== R8x[i];
        sig[i].R8y <== R8y[i];
        sig[i].M   <== spendMessage;

        // member ∈ orgMemberRoot (enforced only when enabled)
        tree[i] = MerkleProof(levels);
        tree[i].leaf <== keyId[i];
        tree[i].pathIndices <== pathIndices[i];
        for (var j = 0; j < levels; j++) {
            tree[i].pathElements[j] <== pathElements[i][j];
        }
        enabled[i] * (tree[i].root - orgMemberRoot) === 0;
    }

    // distinct signers: no two ENABLED slots may share a key-id (degree-2 split)
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

    // count of enabled slots >= threshold
    var sum = 0;
    for (var i = 0; i < maxSigners; i++) {
        sum += enabled[i];
    }
    signal count;
    count <== sum;
    component ge = GreaterEqThan(8);
    ge.in[0] <== count;
    ge.in[1] <== threshold;
    ge.out === 1;

    // bind the authorization to (spendMessage, org)
    component tag = Poseidon(2);
    tag.inputs[0] <== spendMessage;
    tag.inputs[1] <== orgMemberRoot;
    tag.out === authTag;
}
