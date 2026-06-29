import type { CreateViewingGrantRequest, DisclosureTier, GrantScope } from "@benzo/types";

const DISCLOSURE_TIERS = ["full", "incoming", "outgoing"] as const satisfies readonly DisclosureTier[];

export type GrantInput = Partial<CreateViewingGrantRequest>;

export type ValidGrantInput = {
  auditorName: string;
  auditorPubKey: string;
  tier: DisclosureTier;
  scope: GrantScope;
  expiry: string;
};

function validScope(scope: unknown): scope is GrantScope {
  if (!scope || typeof scope !== "object") return false;
  const s = scope as Partial<GrantScope>;
  return Array.isArray(s.accountIds) && (s.from === null || typeof s.from === "string") && (s.to === null || typeof s.to === "string");
}

export function validateGrantInput(body: GrantInput): { ok: true; value: ValidGrantInput } | { ok: false; error: string } {
  const auditorName = body.auditorName?.trim();
  const auditorPubKey = body.auditorPubKey?.trim();
  const tier = body.tier;
  const expiry = body.expiry?.trim();

  if (!auditorName) return { ok: false, error: "auditor name is required" };
  if (!auditorPubKey) return { ok: false, error: "auditor public key is required" };
  if (!tier || !DISCLOSURE_TIERS.includes(tier)) return { ok: false, error: "disclosure tier is invalid" };
  if (!validScope(body.scope)) return { ok: false, error: "grant scope is invalid" };
  if (!expiry || Number.isNaN(Date.parse(expiry))) return { ok: false, error: "expiry is invalid" };

  return {
    ok: true,
    value: {
      auditorName,
      auditorPubKey,
      tier,
      scope: {
        accountIds: body.scope.accountIds,
        from: body.scope.from,
        to: body.scope.to,
        label: body.scope.label?.trim() || undefined,
      },
      expiry,
    },
  };
}
