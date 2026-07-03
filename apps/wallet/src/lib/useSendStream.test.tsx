import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentGoogleCredential: vi.fn(),
  sendStream: vi.fn(),
  clientSideReadsAvailable: vi.fn(),
  sendClientSide: vi.fn(),
  decodeRecipient: vi.fn(),
  saveLocalHistory: vi.fn(),
}));

vi.mock("./api", () => ({
  currentGoogleCredential: mocks.currentGoogleCredential,
  api: { sendStream: mocks.sendStream },
}));

vi.mock("./benzoClient", () => ({
  clientSideReadsAvailable: mocks.clientSideReadsAvailable,
  sendClientSide: mocks.sendClientSide,
}));

vi.mock("./recipient", () => ({
  decodeRecipient: mocks.decodeRecipient,
}));

vi.mock("./history", () => ({
  saveLocalHistory: mocks.saveLocalHistory,
}));

import { useSendStream } from "./useSendStream";

describe("useSendStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs client-side send flow successfully", async () => {
    mocks.decodeRecipient.mockReturnValue({ type: "address", address: "G..." });
    mocks.sendClientSide.mockResolvedValue({ txHash: "tx_local", prover: "local" });
    const { result } = renderHook(() => useSendStream());

    let r: unknown;
    await act(async () => {
      r = await result.current.run("bzr_recipient", "2.5", "memo", "local");
    });

    expect(r).toEqual({
      status: "settled",
      txHash: "tx_local",
      prover: "local",
      amount: "25000000",
      onChain: true,
    });
    expect(mocks.decodeRecipient).toHaveBeenCalledWith("bzr_recipient");
    expect(mocks.sendClientSide).toHaveBeenCalledWith({ type: "address", address: "G..." }, "25000000");
    expect(mocks.saveLocalHistory).toHaveBeenCalled();
  });

  it("fails if the recipient code is invalid", async () => {
    mocks.decodeRecipient.mockReturnValue(null);
    const { result } = renderHook(() => useSendStream());

    let r: unknown;
    await act(async () => {
      r = await result.current.run("invalid_recipient", "2.5", "memo", "local");
    });

    expect(r).toBeNull();
    expect(result.current.state.error).toBe("Invalid private recipient code.");
  });

  it("handles client-side send failure", async () => {
    mocks.decodeRecipient.mockReturnValue({ type: "address", address: "G..." });
    mocks.sendClientSide.mockRejectedValue(new Error("RPC timeout"));
    const { result } = renderHook(() => useSendStream());

    let r: unknown;
    await act(async () => {
      r = await result.current.run("bzr_recipient", "2.5", "memo", "local");
    });

    expect(r).toBeNull();
    expect(result.current.state.error).toBe("RPC timeout");
  });
});
