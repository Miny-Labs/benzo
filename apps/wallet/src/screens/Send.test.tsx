import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Send } from "./Send";

const walletState = vi.hoisted(() => ({
  session: {
    profile: { handle: "tester", name: "Tester" },
    handle: "tester",
    kycTier: 1,
    live: true,
    mode: "live",
    missing: [],
    prover: { available: ["local"], mode: "local", location: "local" },
  },
  balance: { stroops: "0", live: true },
  publicBalance: { stroops: "0", address: "G".padEnd(56, "A"), asset: "USDC", issuer: "I".padEnd(56, "A"), live: true },
  history: [],
  contacts: [],
  loading: false,
  error: null,
  hidden: false,
  toggleHidden: vi.fn(),
  deviceVerified: false,
  refresh: vi.fn(async () => true),
  refreshBalance: vi.fn(async () => undefined),
}));

vi.mock("../lib/store", () => ({
  useWallet: () => walletState,
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    currentGoogleCredential: () => null,
    api: {
      ...actual.api,
    },
  };
});

vi.mock("../lib/useSendStream", () => ({
  useSendStream: () => ({
    state: { phase: "idle" },
    receipt: null,
    run: vi.fn(),
    reset: vi.fn(),
  }),
}));

describe("Send", () => {
  it("opens and dismisses the compliance step-up sheet before balance checks", async () => {
    render(
      <MemoryRouter initialEntries={["/send"]}>
        <Send />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByTestId("send-handle"), { target: { value: "GBRMUZELYDNXSBYF5KOLLSV4XLQYNZJQNLXQ3HTFCWNRIBS3I6EUBCMP" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1001" } });

    expect(screen.getByTestId("send-overcap-hint")).toHaveTextContent("Sends over $1,000");
    expect(screen.queryByTestId("send-low-private")).not.toBeInTheDocument();

    const submit = screen.getByTestId("send-submit");
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent("Verify · $1,001.00");

    fireEvent.click(submit);
    expect(await screen.findByTestId("send-stepup")).toBeInTheDocument();
    expect(screen.getByText("Verify to send more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("stepup-later"));
    await waitFor(() => expect(screen.queryByTestId("send-stepup")).not.toBeInTheDocument());
  });
});
