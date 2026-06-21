pragma circom 2.2.2;
// Entry: org-NOTE spend authorization (stage 1 of the in-circuit M-of-N merge).
// Same M-of-N over a 16-level member tree, up to 3 signer slots, PLUS the
// recipientPk binding that lets the merged joinsplit prove "this M-of-N approval
// is for THIS org note" (recipientPk == note.recipient_pk). See _impl for the
// preimage-resistance soundness argument.
include "./org_note_spend_impl.circom";
component main {public [orgMemberRoot, threshold, spendMessage, recipientPk, nullifier]} = OrgNoteSpend(16, 3);
