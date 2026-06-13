pragma circom 2.2.2;

// M0 de-risking circuit: prove knowledge of a, b with a*b == c.
// Public: c. Private: a, b.
// The point of this circuit is not the statement — it is to retire the
// largest unknown in one loop: snarkjs proving -> Soroban BN254 host
// functions -> on-chain Groth16 verification on testnet.
template Trivial() {
    signal input a;
    signal input b;
    signal input c;

    c === a * b;
}

component main {public [c]} = Trivial();
