import { describe, it, expect } from "vitest";
import {
  seal, open, generateViewingKeypair, encodeNotePlain, decodeNotePlain,
  _aesOpenAttempts, _resetAesOpenAttempts,
} from "../src/viewkeys.js";

const note = encodeNotePlain({ amount: 1n, recipientPk: 2n, blinding: 3n, assetId: 4n });

describe("note-discovery view-tag fast path", () => {
  it("a tagged note opens for the right key, not the wrong one", () => {
    const A = generateViewingKeypair();
    const B = generateViewingKeypair();
    const box = seal(note, A.publicKey).bytes;
    const opened = open(box, A.secret);
    expect(opened).not.toBeNull();
    expect(decodeNotePlain(opened!).amount).toBe(1n);
    expect(open(box, B.secret)).toBeNull();
  });

  it("skips the AES open for non-matching notes (fast path)", () => {
    const A = generateViewingKeypair();
    const B = generateViewingKeypair();
    const boxes = [seal(note, A.publicKey).bytes, ...Array.from({ length: 12 }, () => seal(note, B.publicKey).bytes)];
    _resetAesOpenAttempts();
    const found = boxes.map((b) => open(b, A.secret)).filter(Boolean);
    expect(found).toHaveLength(1); // only A's note decrypts
    // the 12 B-notes are skipped at the 1-byte tag check; only A's note (plus the
    // rare ~1/256 tag collision) ever reaches AES-GCM.
    expect(_aesOpenAttempts).toBeLessThan(boxes.length);
    expect(_aesOpenAttempts).toBeGreaterThanOrEqual(1);
  });

  it("backward-compat: a legacy (untagged v0) box still opens", () => {
    const A = generateViewingKeypair();
    const legacy = seal(note, A.publicKey).bytes.slice(5); // strip "BNZ1"+tag => v0 layout
    const opened = open(legacy, A.secret);
    expect(opened).not.toBeNull();
    expect(decodeNotePlain(opened!).amount).toBe(1n);
  });
});
