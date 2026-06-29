import { describe, expect, it } from "vitest";
import { validateGrantInput } from "./grantValidation.js";

const valid = {
  auditorName: "Codex Auditor",
  auditorPubKey: "0xabc123",
  tier: "outgoing" as const,
  scope: { accountIds: [], from: null, to: null, label: "2026-Q2" },
  expiry: "2026-09-27T00:00:00.000Z",
};

describe("validateGrantInput", () => {
  it("requires real auditor identity fields", () => {
    expect(validateGrantInput({ ...valid, auditorName: " " })).toEqual({ ok: false, error: "auditor name is required" });
    expect(validateGrantInput({ ...valid, auditorPubKey: "" })).toEqual({ ok: false, error: "auditor public key is required" });
  });

  it("rejects invalid tier, scope, and expiry", () => {
    expect(validateGrantInput({ ...valid, tier: "viewer" as never })).toEqual({ ok: false, error: "disclosure tier is invalid" });
    expect(validateGrantInput({ ...valid, scope: undefined })).toEqual({ ok: false, error: "grant scope is invalid" });
    expect(validateGrantInput({ ...valid, expiry: "not-a-date" })).toEqual({ ok: false, error: "expiry is invalid" });
  });

  it("normalizes valid grants", () => {
    expect(validateGrantInput({ ...valid, auditorName: " Codex Auditor ", auditorPubKey: " 0xabc123 ", scope: { ...valid.scope, label: " Q2 Payroll " } })).toEqual({
      ok: true,
      value: { ...valid, auditorName: "Codex Auditor", auditorPubKey: "0xabc123", scope: { ...valid.scope, label: "Q2 Payroll" } },
    });
  });
});
