import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatePaymentRequest } from "@benzo/types";
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

describe("console API idempotency", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("reuses a mutation idempotency key after a network failure, then clears it after a response", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse({ id: "pay_1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "pay_2" }));
    vi.stubGlobal("fetch", fetchMock);

    const body = {
      type: "shielded_transfer",
      fromAccountId: "acc_operating",
      toCounterpartyId: "cp_vendor",
      amount: { amount: "10000000", assetCode: "USDC" },
    } satisfies CreatePaymentRequest;

    await expect(api.createPayment(body)).rejects.toThrow("network down");
    const firstKey = callHeaders(fetchMock.mock.calls[0]).get("idempotency-key");
    expect(firstKey).toMatch(/^idem_/);

    await api.createPayment(body);
    const retryKey = callHeaders(fetchMock.mock.calls[1]).get("idempotency-key");
    expect(retryKey).toBe(firstKey);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("benzo.idempotency.console.v1:"))).toEqual([]);

    await api.createPayment(body);
    const nextKey = callHeaders(fetchMock.mock.calls[2]).get("idempotency-key");
    expect(nextKey).toMatch(/^idem_/);
    expect(nextKey).not.toBe(firstKey);
  });

  it("adds auth and idempotency headers for console money movement", async () => {
    localStorage.setItem("benzo.console.googleCredential", "google.jwt");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ invoice: { id: "inv_1" }, payment: { id: "pay_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.payInvoice("inv_1");

    expect(fetchMock.mock.calls[0][0]).toBe(apiHref("/invoices/inv_1/pay"));
    const headers = callHeaders(fetchMock.mock.calls[0]);
    expect(headers.get("authorization")).toBe("Bearer google.jwt");
    expect(headers.get("idempotency-key")).toMatch(/^idem_/);
  });

  it("keeps a mutation idempotency key after a 5xx response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ invoice: { id: "inv_1" }, payment: { id: "pay_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.payInvoice("inv_1")).rejects.toThrow("temporarily unavailable");
    const firstKey = callHeaders(fetchMock.mock.calls[0]).get("idempotency-key");

    await api.payInvoice("inv_1");
    expect(callHeaders(fetchMock.mock.calls[1]).get("idempotency-key")).toBe(firstKey);
  });
});
