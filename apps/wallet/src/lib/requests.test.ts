import { describe, it, expect, beforeEach } from "vitest";

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

import { addRequest, listRequests, findRequest, cancelRequest, markPaid, markReminded, remindedToday, updateRequestStatus } from "./requests.js";

const DAY = 24 * 3600;

describe("money requests (C7 - local, private, no public feed)", () => {
  beforeEach(() => mem.clear());

  it("creates a pending request with a 30-day expiry", () => {
    const r = addRequest({ id: "rq1", link: "benzo:...", amount: "5000000", memo: "Lunch" }, 1000);
    expect(r.status).toBe("pending");
    expect(r.expiresAt).toBe(1000 + 30 * DAY);
    expect(listRequests(1000)).toHaveLength(1);
  });

  it("auto-derives 'expired' past the deadline (not stored eagerly)", () => {
    addRequest({ id: "rq1", link: "x" }, 1000);
    expect(listRequests(1000 + 10 * DAY)[0].status).toBe("pending");
    expect(listRequests(1000 + 31 * DAY)[0].status).toBe("expired");
  });

  it("cancel and markPaid are terminal", () => {
    addRequest({ id: "a", link: "x" }, 1000);
    addRequest({ id: "b", link: "y" }, 1001);
    cancelRequest("a");
    markPaid("b", "2000000");
    const rs = listRequests(1002);
    expect(rs.find((r) => r.id === "a")?.status).toBe("cancelled");
    expect(findRequest("a", 1002)?.status).toBe("cancelled");
    const b = rs.find((r) => r.id === "b");
    expect(b?.status).toBe("paid");
    expect(b?.paidAmount).toBe("2000000");
  });

  it("tracks partially paid request state", () => {
    addRequest({ id: "partial", link: "x", amount: "5000000" }, 1000);
    updateRequestStatus("partial", "partially_paid", "2000000");
    const r = findRequest("partial", 1001);
    expect(r?.status).toBe("partially_paid");
    expect(r?.paidAmount).toBe("2000000");
  });

  it("rate-limits reminders to once per day", () => {
    const r = addRequest({ id: "a", link: "x" }, 1000);
    expect(remindedToday(r, 1000)).toBe(false);
    markReminded("a", 5000);
    const after = listRequests(5000 + 3600).find((x) => x.id === "a")!;
    expect(remindedToday(after, 5000 + 3600)).toBe(true); // within 24h
    expect(remindedToday(after, 5000 + 25 * 3600)).toBe(false); // next day
  });

  it("dedupes by id (re-adding replaces), newest first", () => {
    addRequest({ id: "a", link: "x", memo: "first" }, 1000);
    addRequest({ id: "b", link: "y" }, 1001);
    addRequest({ id: "a", link: "x", memo: "second" }, 1002); // same id
    const rs = listRequests(1003);
    expect(rs).toHaveLength(2);
    expect(rs[0].id).toBe("a"); // re-added -> newest
    expect(rs[0].memo).toBe("second");
  });
});
