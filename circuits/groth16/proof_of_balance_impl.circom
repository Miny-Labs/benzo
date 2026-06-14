pragma circom 2.2.2;

// Benzo proof-of-balance / proof-of-funds.
//
// Proves: "I own up to `nNotes` notes in the pool Merkle tree (one spend key),
// whose amounts sum to at least `threshold`" — WITHOUT revealing the amounts,
// how many notes, or which leaves they are.
//
// Public  : root, threshold, assetId, context
// Private : spendSk, and per slot { amount, blinding, pathIndices, pathElements }
//
// Padding: unused slots use amount 0; their Merkle-root check is disabled via
// ForceEqualIfEnabled(enabled = amount), exactly as the join-split input side
// treats dummy inputs. Each amount is 64-bit range-checked so the sum cannot
// wrap mod p before the threshold comparison.

include "./note.circom";
include "../lib/merkleProof.circom";
include "../lib/circomlib/circuits/comparators.circom";

template ProofOfBalance(levels, nNotes) {
    // ---- public ----
    signal input root;       // a recent pool Merkle root
    signal input threshold;  // minimum total balance being proven
    signal input assetId;    // asset domain (USDC SAC)
    signal input context;    // verifier-chosen binding (request/recipient nonce)

    // ---- private ----
    signal input spendSk;
    signal input amount[nNotes];
    signal input blinding[nNotes];
    signal input pathIndices[nNotes];
    signal input pathElements[nNotes][levels];

    // Bind `context` into the constraint system so the proof commits to it
    // (prevents replay for a different request); value is otherwise free.
    signal contextSq;
    contextSq <== context * context;

    // Single owner: recipientPk = Poseidon2(spendSk, 0).
    component kp = BenzoKeypair();
    kp.spendSk <== spendSk;

    component range[nNotes];
    component commit[nNotes];
    component tree[nNotes];
    component checkRoot[nNotes];

    var sum = 0;
    for (var i = 0; i < nNotes; i++) {
        // 64-bit range so the running sum cannot overflow the field.
        range[i] = AmountCheck();
        range[i].amount <== amount[i];

        // commitment = Poseidon2(amount, pk, blinding, assetId)
        commit[i] = BenzoNoteCommitment();
        commit[i].amount      <== amount[i];
        commit[i].recipientPk <== kp.publicKey;
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

    // sum >= threshold. Amounts are 64-bit and nNotes <= 8, so sum < 2^67;
    // 70 bits covers both operands with margin.
    component geq = GreaterEqThan(70);
    geq.in[0] <== sum;
    geq.in[1] <== threshold;
    geq.out === 1;
}
