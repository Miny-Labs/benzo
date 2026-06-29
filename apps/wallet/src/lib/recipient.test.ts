import { describe, expect, it } from "vitest";
import { classifyRecipientInput, hasBadHandleSyntax, isValidHandleRecipient } from "./recipient";

describe("recipient classification", () => {
  it("accepts valid Benzo handles with or without @", () => {
    expect(isValidHandleRecipient("@mara_1")).toBe(true);
    expect(isValidHandleRecipient("mara.1")).toBe(true);
    expect(classifyRecipientInput("@mara_1")).toBe("handle");
    expect(classifyRecipientInput("mara.1")).toBe("handle");
  });

  it("flags malformed @handles before review", () => {
    expect(hasBadHandleSyntax("@bad!")).toBe(true);
    expect(hasBadHandleSyntax("@ab")).toBe(true);
    expect(hasBadHandleSyntax("@thishandleistoolongforbenzo")).toBe(true);
    expect(hasBadHandleSyntax("@valid_name")).toBe(false);
  });

  it("keeps freeform non-handle recipients in invite flow", () => {
    expect(classifyRecipientInput("not an account yet")).toBe("invite");
  });
});
