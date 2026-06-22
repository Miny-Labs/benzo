pragma circom 2.2.2;
// Entry point: ORG proof-of-balance / proof-of-funds over the depth-32 pool tree,
// up to 4 org treasury notes. Public: root, minTotal, assetId, context. Owner is
// the M-of-N org-note identity. Powers funded✓ / reserves / solvency.
include "./proof_of_balance_org_impl.circom";
component main {public [root, minTotal, assetId, context]} = ProofOfBalanceOrg(32, 4);
