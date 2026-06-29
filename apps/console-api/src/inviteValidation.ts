import type { OrgInvite } from "./store.js";

const MEMBER_ROLES = ["owner", "admin", "treasurer", "approver", "auditor"] as const;

export type InviteInput = {
  kind?: OrgInvite["kind"];
  name?: string;
  email?: string;
  role?: string;
  handle?: string;
};

export type ValidInviteInput = {
  kind: OrgInvite["kind"];
  name?: string;
  email?: string;
  role?: string;
  handle?: string;
};

export function validateInviteInput(body: InviteInput): { ok: true; value: ValidInviteInput } | { ok: false; error: string } {
  const kind = body.kind ?? "member";
  if (!["member", "contractor", "customer"].includes(kind)) return { ok: false, error: "invite kind is invalid" };

  const name = body.name?.trim() || undefined;
  const email = body.email?.trim() || undefined;
  const handle = body.handle?.trim() || undefined;
  const role = body.role?.trim() || undefined;

  if (kind === "member") {
    if (!email) return { ok: false, error: "email is required for team invites" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "email is invalid" };
    if (!role) return { ok: false, error: "role is required for team invites" };
    if (!MEMBER_ROLES.includes(role as typeof MEMBER_ROLES[number])) return { ok: false, error: "role is invalid" };
    return { ok: true, value: { kind, name, email, role } };
  }

  if (!name) return { ok: false, error: `${kind} name is required` };
  if (handle && !/^@?[a-z0-9_.]{3,20}$/i.test(handle)) return { ok: false, error: "handle is invalid" };
  return { ok: true, value: { kind, name, handle } };
}
