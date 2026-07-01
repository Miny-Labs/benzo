import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: undefined });
});

describe("copyTextToClipboard", () => {
  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(copyTextToClipboard("GABC")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("GABC");
  });

  it("falls back to execCommand when async clipboard is blocked", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.assign(navigator, { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    const exec = vi.spyOn(document, "execCommand").mockReturnValue(true);

    await expect(copyTextToClipboard("GDEF")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("reports failure when no copy path succeeds", async () => {
    Object.assign(navigator, { clipboard: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    vi.spyOn(document, "execCommand").mockReturnValue(false);

    await expect(copyTextToClipboard("GHI")).resolves.toBe(false);
  });
});
