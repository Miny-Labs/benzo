import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeAll, expect, test } from "vitest";

let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

beforeAll(async () => {
  process.env.VERCEL = "1";
  process.env.BENZO_DEV_EXPORT = "1";
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

test("fails closed for nested wallet endpoints when live client is unavailable", async () => {
  const res = await request(`/api/rpc?path=${encodeURIComponent("/handle/available?h=ab")}`);
  expect(res.status).toBe(503);
  await expect(res.json()).resolves.toMatchObject({
    live: false,
    mode: "unavailable",
    error: "Live testnet client unavailable. Refusing to serve app data.",
  });
});

test("fails closed before hosted wallet account export can expose anything", async () => {
  const res = await request("/api/dev/account");
  expect(res.status).toBe(503);
  await expect(res.json()).resolves.toMatchObject({
    live: false,
    mode: "unavailable",
    error: "Live testnet client unavailable. Refusing to serve app data.",
  });
});
