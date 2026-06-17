pragma circom 2.2.2;

// Benzo ZK-KYC credential.
//
// Proves, in zero knowledge, that the holder possesses a valid KYC/KYB
// credential signed by an AUTHORIZED issuer (Plaid — KYB for business, Identity
// Verification for personal — or a self-issued demo issuer) — WITHOUT revealing
// any PII. The
// output is an `admitLeaf` the allow-set admits by proof (replacing the
// operator-trusted insert) plus a scope-bound sybil `identityNullifier`.
//
// Construction (Galactica zkKYC shape): an issuer signs a credential message
// with EdDSA-over-BabyJubJub (circomlib EdDSAPoseidonVerifier, which carries the
// mandatory S<l malleability guard); the circuit verifies the signature, proves
// the issuer is a member of the authorized-issuer registry, checks the credential
// is unexpired, binds the credential to the holder's own key, and derives a
// Semaphore-style one-person-one-scope nullifier.
//
// Public  : [issuerRegistryRoot, credType, currentTime, scope,
//            identityNullifier, addressBinding, admitLeaf]
// Private : the issuer pubkey + signature, the holder key, the credential
//           attributes, the issuer Merkle path, and the admit blinding.

include "../lib/circomlib/circuits/eddsaposeidon.circom";
include "../lib/circomlib/circuits/poseidon.circom";
include "../lib/circomlib/circuits/babyjub.circom";
include "../lib/circomlib/circuits/comparators.circom";
include "../lib/merkleProof.circom";

template KycCredential(issuerLevels) {
    // ---- public ----
    signal input issuerRegistryRoot; // root of the authorized-issuer registry
    signal input credType;           // 0 = business (Plaid KYB), 1 = personal (Plaid IDV), ...
    signal input currentTime;        // verifier-supplied (checked vs ledger time on-chain)
    signal input scope;              // app/epoch scope for the sybil nullifier
    signal input identityNullifier;  // one-person-one-scope nullifier (output)
    signal input addressBinding;     // binds the credential to the holder (output)
    signal input admitLeaf;          // allow-set admission leaf (output)

    // ---- private ----
    signal input issuerAx;           // issuer BabyJubJub pubkey
    signal input issuerAy;
    signal input sigS;               // EdDSA signature (S, R8)
    signal input sigR8x;
    signal input sigR8y;
    signal input holderSk;           // holder BabyJubJub private scalar
    signal input attrHash;           // hash of the KYC attributes (no PII on-chain)
    signal input expiry;             // credential expiry (unix seconds)
    signal input serial;             // credential serial (issuer-chosen)
    signal input issuerPathElements[issuerLevels];
    signal input issuerPathIndices;
    signal input admitBlinding;

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

    // 3. The signed credential message binds every credential field.
    component msg = Poseidon(6);
    msg.inputs[0] <== attrHash;
    msg.inputs[1] <== addressBinding;
    msg.inputs[2] <== ik.out;
    msg.inputs[3] <== expiry;
    msg.inputs[4] <== credType;
    msg.inputs[5] <== serial;

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

    // 6. Credential is not expired: expiry > currentTime.
    // Bit-constrain BOTH comparands to 64 bits first. GreaterThan/LessThan only
    // range-check the internal difference, so feeding unconstrained inputs is the
    // classic RangeProof alias footgun (zkSecurity circom-pitfalls, 0xPARC
    // zk-bug-tracker). Defense in depth: `expiry` is already bound by the issuer
    // signature (step 4) and `currentTime` is a public, honestly-supplied input,
    // but the comparator must be sound on its own terms.
    component expiryBits = Num2Bits(64);
    expiryBits.in <== expiry;
    component timeBits = Num2Bits(64);
    timeBits.in <== currentTime;

    component notExpired = GreaterThan(64);
    notExpired.in[0] <== expiry;
    notExpired.in[1] <== currentTime;
    notExpired.out === 1;

    // 7. Sybil one-person-one-scope nullifier = Poseidon(scope, holderSk).
    component idn = Poseidon(2);
    idn.inputs[0] <== scope;
    idn.inputs[1] <== holderSk;
    idn.out === identityNullifier;

    // 8. Allow-set admission leaf = Poseidon(addressBinding, admitBlinding).
    component al = Poseidon(2);
    al.inputs[0] <== addressBinding;
    al.inputs[1] <== admitBlinding;
    al.out === admitLeaf;
}
