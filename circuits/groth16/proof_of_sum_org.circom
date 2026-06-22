pragma circom 2.2.2;
// Entry point: ORG proof-of-sum / disclose-total over the depth-32 pool tree, up
// to 4 org treasury notes. Same public shape as proof_of_sum (root, claimedTotal,
// assetId, context); the owner is the M-of-N org-note identity, not a single key.
include "./proof_of_sum_org_impl.circom";
component main {public [root, claimedTotal, assetId, context]} = ProofOfSumOrg(32, 4);
