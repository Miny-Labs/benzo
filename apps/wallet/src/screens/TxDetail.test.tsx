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
});
