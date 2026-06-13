import { describe, it, expect } from "vitest";
import { selectSpendNotes } from "../src/client.js";

const mk = (amount: bigint, leafIndex = 0) => ({
  note: { amount, recipientPk: 1n, blinding: 2n, assetId: 3n },
  spendSk: 9n,
  leafIndex,
});

describe("selectSpendNotes — 2-in coin selection", () => {
  it("returns the smallest single note that covers the amount", () => {
    const r = selectSpendNotes([mk(5n, 0), mk(10n, 1), mk(20n, 2)], 8n);
    expect(r).toHaveLength(1);
    expect(r[0].note.amount).toBe(10n);
  });

  it("falls back to the two largest notes when no single note covers", () => {
    const r = selectSpendNotes([mk(5n, 0), mk(6n, 1), mk(7n, 2)], 12n); // 7+6 covers
    expect(r).toHaveLength(2);
    expect(r.map((n) => n.note.amount).sort()).toEqual([6n, 7n]);
  });

  it("returns [] when even the two largest cannot cover", () => {
    expect(selectSpendNotes([mk(1n, 0), mk(2n, 1)], 100n)).toHaveLength(0);
  });

  it("returns [] for an empty wallet", () => {
    expect(selectSpendNotes([], 1n)).toHaveLength(0);
  });

  it("prefers a single covering note over spending two", () => {
    const r = selectSpendNotes([mk(10n, 0), mk(7n, 1), mk(8n, 2)], 10n);
    expect(r).toHaveLength(1);
    expect(r[0].note.amount).toBe(10n);
  });
});
