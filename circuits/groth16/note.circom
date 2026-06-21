pragma circom 2.2.2;

// Benzo shared note templates — the canonical cryptographic invariants.
//
//   commitment = Poseidon2(amount, recipient_pk, blinding, asset_id)
//                (t=4 permutation; asset_id occupies the capacity slot)
//   nullifier  = Poseidon2(spend_sk, leaf_index, NULLIFIER_DOMAIN)
//                (t=3 permutation; NULLIFIER_DOMAIN = 0x02 in the capacity slot)
//   keypair    : recipient_pk = Poseidon2(spend_sk, 0) with domain 0x03
//   mvk tag    : tag = Poseidon2(mvk_pub, blinding) with domain 0x05
//
// All Poseidon2 instances use the parameterization pinned in
// circuits/lib/poseidon2/poseidon2_const.circom — byte-identical to the
// Soroban CAP-0075 host-function parameters in contracts/common/soroban-utils.

include "../lib/poseidon2/poseidon2_hash.circom";
include "../lib/circomlib/circuits/bitify.circom";

// Domain-separation constants (capacity-slot values).
function NULLIFIER_DOMAIN() { return 0x02; }
function KEYPAIR_DOMAIN()   { return 0x03; }
function MVK_TAG_DOMAIN()   { return 0x05; }
function ASP_LEAF_DOMAIN()  { return 0x01; }
// Key-hierarchy domains (canonical map, see docs/ZK-AUDIT-AND-STANDARDS.md C.2).
function SPENDAUTH_DOMAIN() { return 0x06; }
function NK_DOMAIN()        { return 0x07; }
function MVK_REGISTRY_LEAF_DOMAIN() { return 0x08; }
function ORG_NOTE_DOMAIN()  { return 0x09; }

// Authorized-MVK registry leaf: Poseidon2(mvk_pub, key_meta), domain 0x08.
// `key_meta` packs org/scope/expiry/epoch (a single field for the MVP). Membership
// of this leaf under the registered-MVK root is what makes "every note is bound to
// a REAL registered viewing key" an enforced invariant rather than a comment —
// closing the audit P0 where a prover could bind a note to a junk/unregistered key.
template BenzoMvkRegistryLeaf() {
    signal input  mvkPub;
    signal input  keyMeta;
    signal output out;

    component h = Poseidon2(2);
    h.inputs[0] <== mvkPub;
    h.inputs[1] <== keyMeta;
    h.domainSeparation <== MVK_REGISTRY_LEAF_DOMAIN();
    out <== h.out;
}

// Key hierarchy: from one committed root `orgSpendId`, derive a spend-auth
// branch `ak` (owner / recipient_pk) and a SEPARATE nullifier key `nk` via
// domain-separated Poseidon2 (Zcash Orchard / Penumbra split). Splitting them
// means a viewing/nullifier key never grants spend authority, and one
// orgSpendId yields exactly one (ak, nk) — killing the "two FVKs, same ak,
// different nk" footgun. N=1 (consumer) is the degenerate case where orgSpendId
// is the single account seed; M-of-N (org) splits orgSpendId off-circuit via
// FROST with `ak` as the group key, leaving this circuit single-signer either way.
template BenzoSpendKeys() {
    signal input  orgSpendId;
    signal output ak;
    signal output nk;

    component ha = Poseidon2(2);
    ha.inputs[0] <== orgSpendId;
    ha.inputs[1] <== 0;
    ha.domainSeparation <== SPENDAUTH_DOMAIN();
    ak <== ha.out;

    component hn = Poseidon2(2);
    hn.inputs[0] <== orgSpendId;
    hn.inputs[1] <== 1;
    hn.domainSeparation <== NK_DOMAIN();
    nk <== hn.out;
}

// recipient_pk = Poseidon2(ak, 0) with the keypair domain. Owner branch only —
// the spend-auth key `ak` (not the raw root) binds note ownership.
template BenzoKeypair() {
    signal input  ak;
    signal output publicKey;

    component h = Poseidon2(2);
    h.inputs[0] <== ak;
    h.inputs[1] <== 0;
    h.domainSeparation <== KEYPAIR_DOMAIN();
    publicKey <== h.out;
}

// commitment = Poseidon2(amount, recipient_pk, blinding, asset_id)
// realized as the t=4 permutation over exactly those four field elements.
template BenzoNoteCommitment() {
    signal input  amount;
    signal input  recipientPk;
    signal input  blinding;
    signal input  assetId;
    signal output out;

    component h = Poseidon2(3);
    h.inputs[0] <== amount;
    h.inputs[1] <== recipientPk;
    h.inputs[2] <== blinding;
    h.domainSeparation <== assetId;
    out <== h.out;
}

// nullifier = Poseidon2(nk, leaf_index, NULLIFIER_DOMAIN) — keyed by the
// dedicated nullifier key `nk`, NOT the owner/spend-auth key, so there is one
// canonical nullifier per note and a viewing key cannot be used to spend.
template BenzoNullifier() {
    signal input  nk;
    signal input  leafIndex;
    signal output out;

    component h = Poseidon2(2);
    h.inputs[0] <== nk;
    h.inputs[1] <== leafIndex;
    h.domainSeparation <== NULLIFIER_DOMAIN();
    out <== h.out;
}

// ORG-NOTE identity: recipient_pk for a dual-control org note =
// Poseidon2(orgMemberRoot, threshold, akGroupPub; ORG_NOTE_DOMAIN). Three bindings
// in one hash: (1) preimage resistance vs KEYPAIR_DOMAIN(0x03) means no single ak
// reproduces it, so the note is unspendable except via the in-circuit M-of-N path;
// (2) threshold is fixed at note creation, so a member cannot lower it; (3) akGroupPub
// PINS the group nullifier key, making the note's nullifier canonical (no double-spend
// via a swapped group key). akGroupPub = BenzoKeypair(akGroup) — a public commitment to
// the secret group key the spending quorum holds.
template BenzoOrgNoteIdentity() {
    signal input  orgMemberRoot;
    signal input  threshold;
    signal input  akGroupPub;
    signal output out;

    component h = Poseidon2(3);
    h.inputs[0] <== orgMemberRoot;
    h.inputs[1] <== threshold;
    h.inputs[2] <== akGroupPub;
    h.domainSeparation <== ORG_NOTE_DOMAIN();
    out <== h.out;
}

// ORG-NOTE nullifier key: nk_org = Poseidon2(akGroup, blinding; NK_DOMAIN). Keyed on
// the per-note `blinding` (already a secret inside the commitment) so two notes of the
// SAME org yield uncorrelated nullifiers — the org spend graph is NOT leakable to an
// observer. Keyed on the secret group key `akGroup` (NOT the viewing key) so the
// auditor/MVK holder, who can see amounts, still cannot LINK spends (Zcash nk/ivk
// split). The final nullifier reuses BenzoNullifier(nk_org, leafIndex), landing in the
// same NullifierSet namespace as consumer notes (same Poseidon2 field family).
template BenzoOrgNullifierKey() {
    signal input  akGroup;
    signal input  blinding;
    signal output nkOrg;

    component h = Poseidon2(2);
    h.inputs[0] <== akGroup;
    h.inputs[1] <== blinding;
    h.domainSeparation <== NK_DOMAIN();
    nkOrg <== h.out;
}

// MVK binding tag: tag = Poseidon2(mvk_pub, blinding) — every note is bound
// to a registered Master Viewing Key; there is no path to an unauditable note.
template BenzoMvkTag() {
    signal input  mvkPub;
    signal input  blinding;
    signal output out;

    component h = Poseidon2(2);
    h.inputs[0] <== mvkPub;
    h.inputs[1] <== blinding;
    h.domainSeparation <== MVK_TAG_DOMAIN();
    out <== h.out;
}

// ASP allow-set leaf: Poseidon2(depositor_scalar, asp_blinding), domain 0x01.
template BenzoAspLeaf() {
    signal input  depositor;
    signal input  aspBlinding;
    signal output out;

    component h = Poseidon2(2);
    h.inputs[0] <== depositor;
    h.inputs[1] <== aspBlinding;
    h.domainSeparation <== ASP_LEAF_DOMAIN();
    out <== h.out;
}

// 64-bit range check for amounts.
template AmountCheck() {
    signal input amount;
    component n2b = Num2Bits(64);
    n2b.in <== amount;
}
