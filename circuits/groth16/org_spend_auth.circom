pragma circom 2.2.2;
// Entry: in-circuit M-of-N org spend authorization over a 16-level member tree,
// up to 3 signer slots (consumer org-of-one = threshold 1; business = M-of-N).
include "./org_spend_auth_impl.circom";
component main {public [orgMemberRoot, threshold, spendMessage, authTag]} = OrgSpendAuth(16, 3);
