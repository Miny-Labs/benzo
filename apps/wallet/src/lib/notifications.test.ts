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

import { deriveNotifications, unreadCount, markAllRead, markRead } from "./notifications.js";
import type { ActivityRow } from "./api.js";

const rows: ActivityRow[] = [
  { id: "r1", type: "receive", name: "Ravi", note: "", amount: "2000000000", direction: "in", status: "settled", timestamp: 100 },
  { id: "r2", type: "send", name: "Alex", note: "", amount: "500000000", direction: "out", status: "settled", timestamp: 300 },
  { id: "r3", type: "cashOut", name: "Cash out", note: "", amount: "1000000000", direction: "out", status: "arriving", timestamp: 200 },
];

describe("notifications (C8 - client-side, derived from history)", () => {
  beforeEach(() => mem.clear());

  it("derives a line per activity row, newest first", () => {
    const ns = deriveNotifications(rows);
    expect(ns.map((n) => n.id)).toEqual(["r2", "r3", "r1"]); // ts 300, 200, 100
    expect(ns[2].title).toBe("Ravi paid you");
    expect(ns[2].body).toBe("+$200.00");
    expect(ns[0].title).toBe("You paid Alex");
    expect(ns.find((n) => n.id === "r3")?.body).toBe("$100.00 returning to the testnet reserve");
  });

  it("counts all as unread initially, then clears on markAllRead", () => {
    expect(unreadCount(rows)).toBe(3);
    expect(deriveNotifications(rows).every((n) => !n.read)).toBe(true);
    markAllRead(rows);
    expect(unreadCount(rows)).toBe(0);
    expect(deriveNotifications(rows).every((n) => n.read)).toBe(true);
  });

  it("markRead clears a single item only", () => {
    markRead("r2");
    expect(unreadCount(rows)).toBe(2);
    expect(deriveNotifications(rows).find((n) => n.id === "r2")?.read).toBe(true);
    expect(deriveNotifications(rows).find((n) => n.id === "r1")?.read).toBe(false);
  });

  it("empty history yields no notifications", () => {
    expect(deriveNotifications([])).toEqual([]);
    expect(unreadCount([])).toBe(0);
  });

  it("HONESTY GATE: 'verified' is true only for a settled row in LIVE mode", () => {
    const settled = rows.find((r) => r.id === "r1")!; // status settled
    const arriving = rows.find((r) => r.id === "r3")!; // status arriving (in-flight)
    // live + settled -> verified
    expect(deriveNotifications([settled], { live: true })[0].verified).toBe(true);
    // live + not-settled -> NOT verified
    expect(deriveNotifications([arriving], { live: true })[0].verified).toBe(false);
    // demo mode -> NEVER verified, even when settled
    expect(deriveNotifications([settled], { live: false })[0].verified).toBe(false);
    expect(deriveNotifications([settled])[0].verified).toBe(false); // default = demo
  });

  it("does not describe failed outgoing rows as paid", () => {
    const failed: ActivityRow = {
      id: "failed-send",
      type: "send",
      name: "Alex",
      note: "",
      amount: "500000000",
      direction: "out",
      status: "failed",
      timestamp: 400,
    };

    const [notif] = deriveNotifications([failed], { live: true });
    expect(notif.title).toBe("Couldn't pay Alex");
    expect(notif.body).toBe("$50.00 was not settled");
    expect(notif.verified).toBe(false);
  });
});
