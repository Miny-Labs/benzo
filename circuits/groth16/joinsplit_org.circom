pragma circom 2.2.2;
// Entry: TRANSFER with in-circuit M-of-N org dual-control. Public-input vector is
// IDENTICAL to the live joinsplit (orgMemberRoot/threshold stay PRIVATE for spend
// privacy). JoinSplitOrg(32, 16): pool depth 32, MVK-registry depth 16.
include "./joinsplit_org_impl.circom";
component main {public [root, assetId, inputNullifier, outputCommitment, fee, extDataHash, mvkTag, registeredMvkRoot]} = JoinSplitOrg(32, 16);
