import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeAll, expect, test } from "vitest";
import { verifyAuditPacket } from "@benzo/private-events";

let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

beforeAll(async () => {
  process.env.VERCEL = "1";
  ({ handle } = await import("./server.js"));
});

async function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const req = Readable.from(init.body ? [Buffer.from(init.body)] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = init.headers ?? {};

  let status = 200;
  let text = "";
  const headers: Record<string, string | number | readonly string[]> = {};
  const setHeader = (name: string, value: string | number | readonly string[]) => {
    headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : value;
  };
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      setHeader(name, value);
      return this;
    },
    writeHead(code: number, nextHeaders?: Record<string, string | number | readonly string[]>) {
      status = code;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) setHeader(name, value);
      return this;
    },
    write(chunk: string | Buffer) {
      text += chunk.toString();
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) text += chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;

  await handle(req, res);
  return {
    status,
    headers,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

test("routes nested console endpoints through the Vercel rpc shim", async () => {
  const res = await request(`/api/rpc?path=${encodeURIComponent("/ledger/verify")}`);
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ ok: true });
});

test("returns and persists private payout handles for console payees", async () => {
  const seeded = await request(`/api/rpc?path=${encodeURIComponent("/counterparties")}`);
  expect(seeded.status).toBe(200);
  const counterparties = await seeded.json() as Array<{ id: string; name: string; paymentAddress?: { shielded?: string } }>;
  expect(counterparties.find((c) => c.id === "cp_grace")?.paymentAddress?.shielded).toBe("@grace");

  const updated = await request(`/api/rpc?path=${encodeURIComponent("/counterparties/cp_new")}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "lucia" }),
  });
  expect(updated.status).toBe(200);
  await expect(updated.json()).resolves.toMatchObject({ id: "cp_new", paymentAddress: { shielded: "@lucia" } });

  const refreshed = await request(`/api/rpc?path=${encodeURIComponent("/counterparties")}`);
  const after = await refreshed.json() as Array<{ id: string; paymentAddress?: { shielded?: string } }>;
  expect(after.find((c) => c.id === "cp_new")?.paymentAddress?.shielded).toBe("@lucia");
});

test("records invoice facts as ciphertext-only private audit packets", async () => {
  const invoice = await request(`/api/rpc?path=${encodeURIComponent("/invoices")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      counterpartyId: "cp_grace",
      number: "INV-PRIVATE-1",
      lineItems: [{ description: "Sensitive inspection work", quantity: 1, unitAmount: "1230000000" }],
      assetCode: "USDC",
    }),
  });
  expect(invoice.status).toBe(201);
  const created = await invoice.json() as { id: string };

  const audit = await request(`/api/rpc?path=${encodeURIComponent("/audit/private-events")}`);
  expect(audit.status).toBe(200);
  const text = await audit.text();
  expect(text).not.toContain("Sensitive inspection work");
  expect(text).not.toContain("INV-PRIVATE-1");
  expect(text).not.toContain("1230000000");

  const body = JSON.parse(text) as {
    packet: Parameters<typeof verifyAuditPacket>[0];
    integrity: { ok: boolean };
  };
  expect(body.integrity.ok).toBe(true);
  expect(verifyAuditPacket(body.packet)).toBe(true);
  expect(body.packet.envelopes.some((e) => e.type === "invoice.created" && e.subjectId === created.id)).toBe(true);
});

test("private audit root anchoring response stays ciphertext-only", async () => {
  const invoice = await request(`/api/rpc?path=${encodeURIComponent("/invoices")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      counterpartyId: "cp_grace",
      number: "INV-ANCHOR-PRIVATE-1",
      lineItems: [{ description: "Anchor packet secret work", quantity: 1, unitAmount: "555000000" }],
      assetCode: "USDC",
    }),
  });
  expect(invoice.status).toBe(201);

  const anchor = await request(`/api/rpc?path=${encodeURIComponent("/audit/private-events/anchor")}`, {
    method: "POST",
    body: "{}",
  });
  expect(anchor.status).toBe(200);
  const text = await anchor.text();
  expect(text).not.toContain("Anchor packet secret work");
  expect(text).not.toContain("INV-ANCHOR-PRIVATE-1");
  expect(text).not.toContain("555000000");
  const body = JSON.parse(text) as { anchor: { onChain: boolean; error?: string }; packetHash: string; orgHash: string };
  expect(body.anchor.onChain).toBe(false);
  expect(body.packetHash).toMatch(/^[0-9a-f]{64}$/);
  expect(body.orgHash).toMatch(/^[0-9a-f]{64}$/);
});
