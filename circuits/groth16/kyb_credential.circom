pragma circom 2.2.2;

// Benzo KYB-as-ZK credential (Z7).
//
// An org proves it holds a valid KYB credential signed by an AUTHORIZED issuer —
// disclosing ONLY "verified business, jurisdiction Y, tier Z" — WITHOUT revealing
// the underlying documents/PII (only their hash is signed, and it stays private).
// A scope-bound `orgNullifier` gives one-credential-per-scope Sybil resistance.
//
// Same Galactica zkKYC shape as kyc_credential, but jurisdiction + tier are
// PUBLIC (selectively disclosed, and signed by the issuer so the org can't lie),
// while the documents (docsHash) stay private.
//
// Public  : [issuerRegistryRoot, jurisdiction, tier, currentTime, scope,
//            orgNullifier, addressBinding]
// Private : issuer pubkey + signature, holder key, docsHash, expiry, serial,
//           issuer Merkle path.

include "../lib/circomlib/circuits/eddsaposeidon.circom";
include "../lib/circomlib/circuits/poseidon.circom";
include "../lib/circomlib/circuits/babyjub.circom";
include "../lib/circomlib/circuits/comparators.circom";
include "../lib/merkleProof.circom";

template KybCredential(issuerLevels) {
    // ---- public ----
    signal input issuerRegistryRoot; // root of the authorized-issuer registry
    signal input jurisdiction;       // DISCLOSED: jurisdiction code (e.g. ISO-3166 as field)
    signal input tier;               // DISCLOSED: KYB tier
    signal input currentTime;        // verifier-supplied (checked vs ledger time on-chain)
    signal input scope;              // app/epoch scope for the sybil nullifier
    signal input orgNullifier;       // one-credential-per-scope nullifier (output)
    signal input addressBinding;     // binds the credential to the holder org (output)

    // ---- private ----
    signal input issuerAx;           // issuer BabyJubJub pubkey
    signal input issuerAy;
    signal input sigS;               // EdDSA signature (S, R8)
    signal input sigR8x;
    signal input sigR8y;
    signal input holderSk;           // holder org BabyJubJub private scalar
    signal input docsHash;           // hash of the KYB documents (NEVER revealed)
    signal input expiry;             // credential expiry (unix seconds)
    signal input serial;             // credential serial (issuer-chosen)
    signal input issuerPathElements[issuerLevels];
    signal input issuerPathIndices;

    // 1. Holder owns the subject: addressBinding = Poseidon(BabyPbk(holderSk)).
    component pbk = BabyPbk();
    pbk.in <== holderSk;
    component addr = Poseidon(2);
    addr.inputs[0] <== pbk.Ax;
    addr.inputs[1] <== pbk.Ay;
    addr.out === addressBinding;

    // 2. Issuer key id = Poseidon(issuerAx, issuerAy).
    component ik = Poseidon(2);
    ik.inputs[0] <== issuerAx;
    ik.inputs[1] <== issuerAy;

    // 3. The signed credential message binds every field, including the DISCLOSED
    //    jurisdiction + tier, so the org cannot claim a jurisdiction/tier the
    //    issuer did not attest.
    component msg = Poseidon(7);
    msg.inputs[0] <== docsHash;
    msg.inputs[1] <== addressBinding;
    msg.inputs[2] <== ik.out;
    msg.inputs[3] <== expiry;
    msg.inputs[4] <== jurisdiction;
    msg.inputs[5] <== tier;
    msg.inputs[6] <== serial;

    // 4. Verify the issuer's EdDSA-Poseidon signature over the message.
    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1;
    sig.Ax  <== issuerAx;
    sig.Ay  <== issuerAy;
    sig.S   <== sigS;
    sig.R8x <== sigR8x;
    sig.R8y <== sigR8y;
    sig.M   <== msg.out;

    // 5. The issuer is a member of the authorized-issuer registry.
    component itree = MerkleProof(issuerLevels);
    itree.leaf        <== ik.out;
    itree.pathIndices <== issuerPathIndices;
    for (var i = 0; i < issuerLevels; i++) {
        itree.pathElements[i] <== issuerPathElements[i];
    }
    itree.root === issuerRegistryRoot;

    // 6. Credential is not expired: expiry > currentTime (both range-checked).
    component expiryBits = Num2Bits(64);
    expiryBits.in <== expiry;
    component timeBits = Num2Bits(64);
    timeBits.in <== currentTime;
    component notExpired = GreaterThan(64);
    notExpired.in[0] <== expiry;
    notExpired.in[1] <== currentTime;
    notExpired.out === 1;

    // 7. Sybil one-credential-per-scope nullifier = Poseidon(scope, holderSk).
    component nf = Poseidon(2);
    nf.inputs[0] <== scope;
    nf.inputs[1] <== holderSk;
    nf.out === orgNullifier;
}

component main {public [issuerRegistryRoot, jurisdiction, tier, currentTime, scope, orgNullifier, addressBinding]} = KybCredential(16);
