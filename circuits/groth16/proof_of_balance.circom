pragma circom 2.2.2;
// Entry point: proof-of-balance over the depth-32 pool tree, up to 4 notes.
include "./proof_of_balance_impl.circom";
component main {public [root, threshold, assetId, context]} = ProofOfBalance(32, 4);
