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

import { normAddress, saveContact, removeContact, isSaved, listLocal, mergeContacts } from "./contacts.js";

const ADDR1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADDR2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("contacts (C6 - local-first recipient management)", () => {
  beforeEach(() => mem.clear());

  it("normalizes Stellar G-addresses", () => {
    expect(normAddress(ADDR1)).toBe(ADDR1);
    expect(normAddress(`  ${ADDR1}  `)).toBe(ADDR1);
    expect(normAddress("not-an-address")).toBe("");
    expect(normAddress("")).toBe("");
  });

  it("saves and de-dupes by address (latest wins, most-recent first)", () => {
    saveContact(ADDR1, "Alex Rivera");
    saveContact(ADDR2, "Bob");
    saveContact(ADDR1, "Alex R."); // same address, new nickname
    const cs = listLocal();
    expect(cs).toHaveLength(2);
    expect(cs[0]).toEqual({ handle: ADDR1, name: "Alex R." }); // updated + moved to front
    expect(isSaved(ADDR1)).toBe(true);
  });

  it("refuses malformed local contacts", () => {
    saveContact("not-an-address", "Bad");
    expect(listLocal()).toHaveLength(0);
  });

  it("removes a saved contact", () => {
    saveContact(ADDR1, "Alex");
    removeContact(ADDR1);
    expect(isSaved(ADDR1)).toBe(false);
    expect(listLocal()).toHaveLength(0);
  });

  it("merges contacts (local-only)", () => {
    saveContact(ADDR1, "My Alex");
    const bff = [
      { handle: ADDR1, name: "Alex Rivera" },
      { handle: ADDR2, name: "Cleo" },
    ];
    const merged = mergeContacts(bff);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("My Alex");
  });
});
