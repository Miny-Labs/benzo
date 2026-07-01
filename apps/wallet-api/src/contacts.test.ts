import { describe, expect, it } from "vitest";
import type { WalletDb } from "./store.js";
import { seed } from "./store.js";
import { walletContactsFromDb } from "./contacts.js";

function fixture(): WalletDb {
  return seed();
}

describe("walletContactsFromDb", () => {
  it("derives recent private counterparties from settled ledger entries", () => {
    const db = fixture();
    db.ledger.push({
      id: "send_1",
      postedAt: 20,
      sourceType: "send_private",
      status: "settled",
      counterparty: "@alice",
      lines: [],
    });
    db.ledger.push({
      id: "send_2",
      postedAt: 30,
      sourceType: "send_private",
      status: "settled",
      counterparty: "bob",
      lines: [],
    });

    expect(walletContactsFromDb(db)).toEqual([
      { handle: "@bob", name: "@bob", tone: "accent" },
      { handle: "@alice", name: "@alice", tone: "accent" },
    ]);
  });

  it("keeps saved contact names while preserving recent counterparties after local removal", () => {
    const db = fixture();
    db.contacts.push({ handle: "@alice", name: "Alice Ops" });
    db.ledger.push({
      id: "send_1",
      postedAt: 20,
      sourceType: "send_private",
      status: "settled",
      counterparty: "@alice",
      lines: [],
    });
    db.ledger.push({
      id: "send_2",
      postedAt: 30,
      sourceType: "send_private",
      status: "settled",
      counterparty: "@cleo",
      lines: [],
    });

    expect(walletContactsFromDb(db)).toEqual([
      { handle: "@cleo", name: "@cleo", tone: "accent" },
      { handle: "@alice", name: "Alice Ops", tone: undefined },
    ]);
  });

  it("does not expose public addresses or failed attempts as contacts", () => {
    const db = fixture();
    db.ledger.push({
      id: "public_1",
      postedAt: 40,
      sourceType: "send_public",
      status: "settled",
      counterparty: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH",
      lines: [],
    });
    db.ledger.push({
      id: "failed_1",
      postedAt: 50,
      sourceType: "send_private",
      status: "failed",
      counterparty: "@failed",
      lines: [],
    });

    expect(walletContactsFromDb(db)).toEqual([]);
  });
});
