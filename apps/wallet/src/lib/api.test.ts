import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiHref } from "./api";

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
});
