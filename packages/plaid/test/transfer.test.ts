/**
 * PlaidTransferClient — the fiat ACH rail lifecycle (authorize → create →
 * simulate posted → settled → event sync). Faked fetch: deterministic, no
 * network (the live Transfer product is account-gated even in Sandbox).
 */
import { describe, it, expect } from "vitest";
import { PlaidTransferClient } from "../src/index.js";

function fakeFetch(): typeof fetch {
  let status = "pending";
  return (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    const reply = (o: unknown) => ({ ok: true, json: async () => o });
    switch (path) {
      case "/transfer/authorization/create":
        return reply({ authorization: { id: "auth_1", decision: "approved" } });
      case "/transfer/create":
        return reply({ transfer: { id: "tr_1", status: "pending" } });
      case "/sandbox/transfer/simulate":
        status = body.event_type;
        return reply({});
      case "/transfer/event/sync":
        return reply({ transfer_events: [{ event_id: 1, event_type: status, transfer_id: "tr_1" }] });
      default:
        throw new Error(`unexpected ${path}`);
    }
  }) as unknown as typeof fetch;
}

describe("PlaidTransferClient (ACH rail lifecycle)", () => {
  it("authorizes, creates, simulates settlement, and reflects it in events", async () => {
    const t = new PlaidTransferClient({ clientId: "id", secret: "sk", fetchImpl: fakeFetch() });
    const auth = await t.authorize({ accessToken: "at", accountId: "acc", amount: "25.00", user: { legal_name: "Ada" } });
    expect(auth.decision).toBe("approved");

    const transfer = await t.create({ accessToken: "at", accountId: "acc", authorizationId: auth.authorizationId, amount: "25.00", description: "benzo shield" });
    expect(transfer.status).toBe("pending");

    await t.sandboxSimulate(transfer.transferId, "posted");
    await t.sandboxSimulate(transfer.transferId, "settled");
    const events = await t.eventSync();
    expect(events[0].event_type).toBe("settled");
    expect(events[0].transfer_id).toBe("tr_1");
  });

  it("surfaces a Plaid error_code", async () => {
    const errFetch = (async () => ({ ok: false, json: async () => ({ error_code: "TRANSFER_NOT_ENABLED" }) })) as unknown as typeof fetch;
    const t = new PlaidTransferClient({ clientId: "id", secret: "sk", fetchImpl: errFetch });
    await expect(t.authorize({ accessToken: "at", accountId: "acc", amount: "1", user: { legal_name: "x" } })).rejects.toThrow(/TRANSFER_NOT_ENABLED/);
  });
});
