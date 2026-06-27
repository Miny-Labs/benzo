import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiHref, AUTH_REQUIRED_EVENT } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function callHeaders(call: unknown[]): Headers {
  return call[1] instanceof Object && "headers" in call[1]
    ? call[1].headers as Headers
    : new Headers();
}

describe("wallet API idempotency", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("reuses a mutation idempotency key after a network failure, then clears it after a response", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse({ status: "settled", amount: "10000000", prover: "tee", onChain: true }))
      .mockResolvedValueOnce(jsonResponse({ status: "settled", amount: "10000000", prover: "tee", onChain: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.addMoney("1", "tee")).rejects.toThrow("network down");
    const firstKey = callHeaders(fetchMock.mock.calls[0]).get("idempotency-key");
    expect(firstKey).toMatch(/^idem_/);

    await api.addMoney("1", "tee");
    const retryKey = callHeaders(fetchMock.mock.calls[1]).get("idempotency-key");
    expect(retryKey).toBe(firstKey);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("benzo.idempotency.wallet.v1:"))).toEqual([]);

    await api.addMoney("1", "tee");
    const nextKey = callHeaders(fetchMock.mock.calls[2]).get("idempotency-key");
    expect(nextKey).toMatch(/^idem_/);
    expect(nextKey).not.toBe(firstKey);
  });

  it("streams private sends through the authenticated RPC gateway with an idempotency key", async () => {
    localStorage.setItem("benzo.googleCredential", "google.jwt");
    const settle = { status: "settled", amount: "25000000", prover: "tee", onChain: true, txHash: "tx_send" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(settle));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.sendStream({ to: "@mara", amount: "2.5", prover: "tee" }, vi.fn())).resolves.toMatchObject(settle);

    expect(fetchMock.mock.calls[0][0]).toBe(apiHref("/send"));
    const headers = callHeaders(fetchMock.mock.calls[0]);
    expect(headers.get("authorization")).toBe("Bearer google.jwt");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("idempotency-key")).toMatch(/^idem_/);
  });

  it("adds idempotency headers to wallet mutation helpers", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", fetchMock);
    const actions: Array<() => Promise<unknown>> = [
      () => api.importDeposit("1", "tee"),
      () => api.makePublic("1", "tee"),
      () => api.sendPublic("G".padEnd(56, "A"), "1"),
      () => api.send("@mara", "1", "memo", "tee"),
      () => api.claimHandle("@alice"),
      () => api.request("1", "memo"),
      () => api.invite("1", "note"),
      () => api.refundInvite("inv_1"),
      () => api.claim("secret", "inv_1"),
      () => api.cashOut("1", "tee"),
      () => api.addMoney("1", "tee"),
      () => api.shareProof("1", "tee"),
    ];

    for (const action of actions) await action();

    expect(fetchMock).toHaveBeenCalledTimes(actions.length);
    for (const call of fetchMock.mock.calls) {
      expect(callHeaders(call).get("idempotency-key")).toMatch(/^idem_/);
    }
  });

  it("keeps a mutation idempotency key after a 5xx response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ status: "settled", amount: "10000000", prover: "tee", onChain: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.addMoney("1", "tee")).rejects.toThrow("temporarily unavailable");
    const firstKey = callHeaders(fetchMock.mock.calls[0]).get("idempotency-key");

    await api.addMoney("1", "tee");
    expect(callHeaders(fetchMock.mock.calls[1]).get("idempotency-key")).toBe(firstKey);
  });

  it("loads proof receipts through the authenticated RPC gateway without mutation idempotency", async () => {
    localStorage.setItem("benzo.googleCredential", "google.jwt");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: "prf_1", action: "wallet.add-money", vkId: "SHIELD", verified: true, createdAt: 1 }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.proofReceipts()).resolves.toHaveLength(1);

    expect(fetchMock.mock.calls[0][0]).toBe(apiHref("/proof-receipts"));
    const headers = callHeaders(fetchMock.mock.calls[0]);
    expect(headers.get("authorization")).toBe("Bearer google.jwt");
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("loads sanitized recovery status without mutation idempotency", async () => {
    localStorage.setItem("benzo.googleCredential", "google.jwt");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", recovery: { bound: true, status: "healthy", custody: "non-custodial", createdAt: 1, lastSeenAt: 2, nextSteps: ["Use this Google sign-in."] } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.recoveryStatus();
    expect(result).toMatchObject({ recovery: { bound: true } });
    expect(result.recovery.nextSteps[0]).toContain("Google");
    expect(result.recovery).not.toHaveProperty("accountFingerprint");
    expect(result.recovery).not.toHaveProperty("subjectKey");

    expect(fetchMock.mock.calls[0][0]).toBe(apiHref("/recovery/status"));
    const headers = callHeaders(fetchMock.mock.calls[0]);
    expect(headers.get("authorization")).toBe("Bearer google.jwt");
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("clears stale hosted auth state when the API requires sign-in again", async () => {
    localStorage.setItem("benzo.googleCredential", "expired.jwt");
    localStorage.setItem("benzo.identityKey", "g123");
    localStorage.setItem("benzo.onboarded", "1");
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Sign in with Google to unlock this wallet." }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.session()).rejects.toThrow("Sign in with Google");

    expect(localStorage.getItem("benzo.googleCredential")).toBeNull();
    expect(localStorage.getItem("benzo.identityKey")).toBeNull();
    expect(localStorage.getItem("benzo.onboarded")).toBeNull();
    expect(onAuthRequired).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  });

  it("does not let an old unauthenticated 401 wipe a fresh Google sign-in", async () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);

    const pending = api.session().catch((e: Error) => e.message);
    localStorage.setItem("benzo.googleCredential", "fresh.jwt");
    resolveFetch?.(jsonResponse({ error: "Sign in with Google to unlock this wallet." }, 401));

    await expect(pending).resolves.toContain("Sign in with Google");
    expect(localStorage.getItem("benzo.googleCredential")).toBe("fresh.jwt");
    expect(onAuthRequired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  });

  it("does not let a stale-token 401 wipe a newer Google sign-in", async () => {
    localStorage.setItem("benzo.googleCredential", "old.jwt");
    let resolveFetch: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);

    const pending = api.session().catch((e: Error) => e.message);
    localStorage.setItem("benzo.googleCredential", "new.jwt");
    resolveFetch?.(jsonResponse({ error: "id token expired" }, 401));

    await expect(pending).resolves.toContain("id token expired");
    expect(localStorage.getItem("benzo.googleCredential")).toBe("new.jwt");
    expect(onAuthRequired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  });
});
