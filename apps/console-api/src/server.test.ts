import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeAll, expect, test } from "vitest";

let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

beforeAll(async () => {
  process.env.VERCEL = "1";
  process.env.BENZO_PRIVATE_EVENT_SECRET = "console-api-test-private-event-secret";
  process.env.BENZO_ACCOUNT_SALT = "console-server-test-salt";
  process.env.BENZO_TEST_AUTH_SECRET = "console-server-test-secret";
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

test("reports unavailable live status when chain env is absent", async () => {
  const res = await request("/api/live");
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ live: false, mode: "unavailable" });
});

test("allows browser idempotency headers", async () => {
  const res = await request("/api/payments", { method: "OPTIONS" });
  expect(res.status).toBe(204);
  expect(String(res.headers["access-control-allow-headers"])).toContain("idempotency-key");
});

test("fails closed for nested hosted console endpoints when user is not signed in", async () => {
  const res = await request(`/api/rpc?path=${encodeURIComponent("/ledger/verify")}`);
  expect(res.status).toBe(401);
  await expect(res.json()).resolves.toMatchObject({
    live: false,
    mode: "unavailable",
    error: "Sign in with Google to unlock this console.",
  });
});

test("fails closed for console writes when live client is unavailable", async () => {
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
  expect(invoice.status).toBe(401);
  await expect(invoice.json()).resolves.toMatchObject({
    live: false,
    mode: "unavailable",
    error: "Sign in with Google to unlock this console.",
  });
});

test("mints secret-gated console test auth for backend smoke tests", async () => {
  const minted = await request("/api/auth/test", {
    method: "POST",
    headers: { "content-type": "application/json", "x-benzo-test-secret": "console-server-test-secret" },
    body: JSON.stringify({ subject: "smoke-console", email: "smoke-console@benzo.local" }),
  });
  expect(minted.status).toBe(200);
  const body = await minted.json() as { token: string };
  expect(body.token).toMatch(/^benzo-test-v1\./);

  const protectedRes = await request(`/api/rpc?path=${encodeURIComponent("/session")}`, {
    headers: { authorization: `Bearer ${body.token}` },
  });
  expect(protectedRes.status).not.toBe(401);
});
