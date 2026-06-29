import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const stateRef = vi.hoisted(() => ({ current: {} as any }));

vi.mock("../lib/store", () => ({
  useConsole: () => stateRef.current,
}));

describe("Dashboard", () => {
  beforeEach(() => {
    localStorage.clear();
    stateRef.current = {
      dashboard: {
        live: true,
        totalPosition: { amount: "1230000000", assetCode: "USDC" },
        pendingApprovals: 0,
        openInvoices: 0,
        scheduledPayrolls: 0,
        recentActivity: [],
      },
      treasury: {
        totalHidden: { amount: "1230000000", assetCode: "USDC" },
      },
      payments: [],
      members: [],
      payrolls: [],
      masked: true,
      loading: false,
      error: null,
      refresh: vi.fn(async () => true),
    };
  });

  it("masks the primary treasury total when amount masking is enabled", () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("treasury-total")).toHaveTextContent("••••••");
    expect(screen.queryByText("$123.00")).not.toBeInTheDocument();
  });
});
