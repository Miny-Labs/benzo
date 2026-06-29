import { expect, test } from "vitest";
import { validateInviteInput } from "./inviteValidation.js";

test("rejects member invites without a valid email and role", () => {
  expect(validateInviteInput({ kind: "member", name: "No Email", role: "approver" })).toEqual({
    ok: false,
    error: "email is required for team invites",
  });
  expect(validateInviteInput({ kind: "member", email: "not-an-email", role: "approver" })).toEqual({
    ok: false,
    error: "email is invalid",
  });
  expect(validateInviteInput({ kind: "member", email: "team@example.com" })).toEqual({
    ok: false,
    error: "role is required for team invites",
  });
  expect(validateInviteInput({ kind: "member", email: "team@example.com", role: "viewer" })).toEqual({
    ok: false,
    error: "role is invalid",
  });
});

test("rejects contractor and customer invites without names", () => {
  expect(validateInviteInput({ kind: "contractor", handle: "@validhandle" })).toEqual({
    ok: false,
    error: "contractor name is required",
  });
  expect(validateInviteInput({ kind: "customer", handle: "@validhandle" })).toEqual({
    ok: false,
    error: "customer name is required",
  });
});

test("normalizes valid invite inputs", () => {
  expect(validateInviteInput({ kind: "member", name: " Ada ", email: " ada@example.com ", role: " owner " })).toEqual({
    ok: true,
    value: { kind: "member", name: "Ada", email: "ada@example.com", role: "owner" },
  });
  expect(validateInviteInput({ kind: "contractor", name: " Grace ", handle: " grace " })).toEqual({
    ok: true,
    value: { kind: "contractor", name: "Grace", handle: "grace" },
  });
});
