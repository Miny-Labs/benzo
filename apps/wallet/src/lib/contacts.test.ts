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

import { normHandle, saveContact, removeContact, isSaved, listLocal, mergeContacts } from "./contacts.js";

describe("contacts (C6 - local-first recipient management)", () => {
  beforeEach(() => mem.clear());

  it("normalizes handles to a single leading @", () => {
    expect(normHandle("alex")).toBe("@alex");
    expect(normHandle("@alex")).toBe("@alex");
    expect(normHandle("ALEX")).toBe("@alex");
    expect(normHandle("  @@alex  ")).toBe("@alex");
    expect(normHandle("")).toBe("");
    expect(normHandle("bo")).toBe("");
    expect(normHandle("bad handle!!!")).toBe("");
    expect(normHandle("a".repeat(21))).toBe("");
  });

  it("saves and de-dupes by handle (latest wins, most-recent first)", () => {
    saveContact("alex", "Alex Rivera");
    saveContact("@bob", "Bob");
    saveContact("alex", "Alex R."); // same handle, new nickname
    const cs = listLocal();
    expect(cs).toHaveLength(2);
    expect(cs[0]).toEqual({ handle: "@alex", name: "Alex R." }); // updated + moved to front
    expect(isSaved("@alex")).toBe(true);
  });

  it("refuses malformed local contacts", () => {
    saveContact("bad handle!!!", "Bad");
    saveContact("bo", "Too short");
    expect(listLocal()).toHaveLength(0);
  });

  it("removes a saved contact", () => {
    saveContact("alex", "Alex");
    removeContact("@alex");
    expect(isSaved("alex")).toBe(false);
    expect(listLocal()).toHaveLength(0);
  });

  it("merges BFF + local, local nickname overrides, de-duped by handle", () => {
    saveContact("alex", "My Alex"); // local nickname
    const bff = [
      { handle: "@alex", name: "Alex Rivera" }, // same person, BFF name
      { handle: "@cleo", name: "Cleo" },
    ];
    const merged = mergeContacts(bff);
    expect(merged).toHaveLength(2); // de-duped
    expect(merged.find((c) => c.handle === "@alex")?.name).toBe("My Alex"); // local wins
    expect(merged.find((c) => c.handle === "@cleo")?.name).toBe("Cleo");
  });
});
