import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "../lib/api";
import { TxDetail } from "./TxDetail";

const state = vi.hoisted(() => ({
  history: [] as ActivityRow[],
  hidden: false,
}));

vi.mock("../lib/store", () => ({
  useWallet: () => state,
}));

describe("TxDetail", () => {
  it("lets a verified private receive row open proof sharing", () => {
    state.history = [{
      id: "h_1_tx",
      type: "receive",
      name: "Paid you",
      note: "Paid you",
      amount: "1000000",
      direction: "in",
      status: "settled",
      timestamp: 1782370212,
      txHash: "2261cc8862eba610a24b293f113864a297f5008885dfdcbc1c3f01c497955417",
      tone: "accent",
    }];

    render(
      <MemoryRouter initialEntries={["/activity/h_1_tx"]}>
        <Routes>
          <Route path="/activity/:id" element={<TxDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("txdetail-explorer")).toBeInTheDocument();
    expect(screen.getByTestId("txdetail-share")).toBeInTheDocument();
  });

  it("describes cash-out rows as testnet reserve settlement, not bank payout", () => {
    state.history = [{
      id: "h_cashout",
      type: "cashOut",
      name: "Cash out",
      note: "",
      amount: "1000000000",
      direction: "out",
      status: "arriving",
      timestamp: 1782370212,
      tone: "amber",
    }];

    render(
      <MemoryRouter initialEntries={["/activity/h_cashout"]}>
        <Routes>
          <Route path="/activity/:id" element={<TxDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Testnet reserve cash-out")).toBeInTheDocument();
    expect(screen.getByText("Returning to testnet reserve")).toBeInTheDocument();
    expect(screen.queryByText(/bank payout|sent to your bank|arriving in your bank/i)).not.toBeInTheDocument();
  });

  it("labels public Stellar sends as public and does not offer private proof sharing", () => {
    state.history = [{
      id: "h_public_send",
      type: "send",
      name: "You sent",
      note: "Public send",
      amount: "10000000",
      direction: "out",
      status: "settled",
      timestamp: 1782370212,
      txHash: "fd9117d121b3d574b0f0899d25779f0784bb0743815089771e560c93f0736fae",
      tone: "neutral",
    }];

    render(
      <MemoryRouter initialEntries={["/activity/h_public_send"]}>
        <Routes>
          <Route path="/activity/:id" element={<TxDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Public Stellar payment")).toBeInTheDocument();
    expect(screen.getByText("Recipient and amount are public on-chain")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByTestId("txdetail-explorer")).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/fd9117d121b3d574b0f0899d25779f0784bb0743815089771e560c93f0736fae",
    );
    expect(screen.queryByTestId("txdetail-share")).not.toBeInTheDocument();
    expect(screen.queryByText(/Only you and/i)).not.toBeInTheDocument();
  });

  it("labels make-public conversions as moving to public balance, not reserve cash-out", () => {
    state.history = [{
      id: "h_make_public",
      type: "unshield",
      name: "Made public",
      note: "Moved to Public balance",
      amount: "10000000",
      direction: "out",
      status: "settled",
      timestamp: 1782370212,
      txHash: "da1d1e97b72b84aeb2e3e9aaa3b7e16ddcd4d7bdb016405ab647c70844b9abdd",
      tone: "amber",
    }];

    render(
      <MemoryRouter initialEntries={["/activity/h_make_public"]}>
        <Routes>
          <Route path="/activity/:id" element={<TxDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Made public").length).toBeGreaterThan(0);
    expect(screen.getByText("Moved to Public balance")).toBeInTheDocument();
    expect(screen.getByText("The source balance stayed hidden")).toBeInTheDocument();
    expect(screen.queryByText("Testnet reserve cash-out")).not.toBeInTheDocument();
    expect(screen.queryByText("Returned to testnet reserve")).not.toBeInTheDocument();
  });

  it("does not present a failed private send as a proved or debited transfer", () => {
    state.history = [{
      id: "h_failed_private",
      type: "send",
      name: "You sent",
      note: "Sent privately · Couldn't send right now. Your money is safe. Please try again.",
      amount: "50000000",
      direction: "out",
      status: "failed",
      timestamp: 1782926977,
      tone: "neutral",
    }];

    render(
      <MemoryRouter initialEntries={["/activity/h_failed_private"]}>
        <Routes>
          <Route path="/activity/:id" element={<TxDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.queryByText("−$5.00")).not.toBeInTheDocument();
    expect(screen.getByText("attempted to")).toBeInTheDocument();
    expect(screen.getByText("Private proof did not complete")).toBeInTheDocument();
    expect(screen.getByText("No on-chain settlement was recorded")).toBeInTheDocument();
    expect(screen.getByText("No on-chain transfer recorded")).toBeInTheDocument();
    expect(screen.queryByText("Proved private")).not.toBeInTheDocument();
    expect(screen.queryByTestId("txdetail-share")).not.toBeInTheDocument();
    expect(screen.queryByTestId("txdetail-explorer")).not.toBeInTheDocument();
  });

  it("treats a legacy nonfailed row with failure copy and no tx as failed", () => {
    state.history = [{
      id: "h_legacy_failed_private",
      type: "send",
      name: "You sent",
      note: "Sent privately · Couldn't send right now. Your money is safe. Please try again.",
      amount: "50000000",
      direction: "out",
      status: "proving",
      timestamp: 1782926977,
      tone: "neutral",
    }];

    render(
      <MemoryRouter initialEntries={["/activity/h_legacy_failed_private"]}>
        <Routes>
          <Route path="/activity/:id" element={<TxDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.queryByText("−$5.00")).not.toBeInTheDocument();
    expect(screen.getByText("attempted to")).toBeInTheDocument();
    expect(screen.getByText("Private proof did not complete")).toBeInTheDocument();
    expect(screen.getByText("No on-chain transfer recorded")).toBeInTheDocument();
    expect(screen.queryByText("Proved private")).not.toBeInTheDocument();
  });
});
