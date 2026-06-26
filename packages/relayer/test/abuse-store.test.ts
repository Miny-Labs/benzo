import { describe, expect, it } from "vitest";
import { createRelayerAbuseStore } from "../src/abuse-store.js";

describe("relayer abuse store", () => {
  it("fails closed in production without a durable database", () => {
    expect(() => createRelayerAbuseStore({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
  });

  it("supports explicit dev memory mode for local tests", async () => {
    const store = createRelayerAbuseStore({ RELAYER_STORE_MEMORY: "1", NODE_ENV: "test" });
    expect(store.durable).toBe(false);
    expect(await store.allow("k", 1, 0)).toBe(true);
    expect(await store.allow("k", 1, 0)).toBe(false);
    expect(await store.takeDaily("day", 1)).toBe(true);
    expect(await store.takeDaily("day", 1)).toBe(false);

    await store.idemSet("n0:n1", { code: 200, body: { txHash: "abc" }, at: Date.now() });
    await expect(store.idemGet("n0:n1", 60_000)).resolves.toMatchObject({ code: 200, body: { txHash: "abc" } });
  });
});
