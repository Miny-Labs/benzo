import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BalanceHero } from "./money";
import { OnChainDetails } from "./OnChainDetails";
import { PrivateChip, ProvableChip } from "./privacy";
import { Button } from "./primitives";
import { ActivityItem } from "./ActivityItem";
import type { ActivityRow } from "../lib/api";

describe("BalanceHero", () => {
  it("renders the formatted balance (accessible label)", () => {
    render(<BalanceHero stroops="12405000000" hidden={false} />);
    expect(screen.getByLabelText("$1,240.50")).toBeInTheDocument();
  });
  it("masks the balance when hidden", () => {
    render(<BalanceHero stroops="12405000000" hidden />);
    expect(screen.getByLabelText("Balance hidden")).toBeInTheDocument();
    expect(screen.queryByLabelText("$1,240.50")).not.toBeInTheDocument();
  });
  it("shows a skeleton while loading", () => {
    render(<BalanceHero stroops="0" hidden={false} loading />);
    expect(screen.getByLabelText("Loading balance")).toBeInTheDocument();
  });
});

describe("privacy chrome", () => {
  it("PrivateChip is ambient (default copy)", () => {
    render(<PrivateChip />);
    expect(screen.getByText(/only you can see this/i)).toBeInTheDocument();
  });
  it("ProvableChip surfaces the proof badge", () => {
    render(<ProvableChip />);
    expect(screen.getByText("Provable")).toBeInTheDocument();
  });
});

describe("Button", () => {
  it("fires onClick and renders children", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Send</Button>);
    fireEvent.click(screen.getByText("Send"));
    expect(onClick).toHaveBeenCalledOnce();
  });
  it("is disabled while loading", () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByText("Go"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ActivityItem", () => {
  const base: ActivityRow = {
    id: "a1", type: "receive", name: "Ravi Mehta", note: "Paid you · Design work",
    amount: "2000000000", direction: "in", status: "settled", timestamp: Math.floor(Date.now() / 1000) - 60,
  };
  it("renders a person row with a positive amount", () => {
    render(<MemoryRouter><ActivityItem row={base} /></MemoryRouter>);
    expect(screen.getByText("Ravi Mehta")).toBeInTheDocument();
    expect(screen.getByText("+$200.00")).toBeInTheDocument();
  });
  it("shows an in-flight status pill for cash-out", () => {
    render(<MemoryRouter><ActivityItem row={{ ...base, type: "cashOut", name: "Cash out", direction: "out", status: "arriving" }} /></MemoryRouter>);
    expect(screen.getByText(/Arriving/)).toBeInTheDocument();
    expect(screen.getByText("−$200.00")).toBeInTheDocument();
  });
  it("shows failed outgoing attempts without a debit sign", () => {
    render(<MemoryRouter><ActivityItem row={{ ...base, type: "send", name: "Alex", direction: "out", status: "failed" }} /></MemoryRouter>);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("$200.00")).toBeInTheDocument();
    expect(screen.queryByText("−$200.00")).not.toBeInTheDocument();
  });
});

describe("OnChainDetails", () => {
  const txHash = "928c3535ab8833e4c59514b4628c1d580c59aea0cf7595f347824c249b5db61d";

  it("labels public wallet sends as public Stellar settlement, not ZK proof", () => {
    render(<OnChainDetails txHash={txHash} onChain kind="public" />);

    fireEvent.click(screen.getByTestId("onchain-toggle"));

    expect(screen.getByText("Public Stellar USDC payment")).toBeInTheDocument();
    expect(screen.getByText("recipient and amount are visible on-chain")).toBeInTheDocument();
    expect(screen.getByText(/normal Stellar USDC payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/Groth16/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Pool contract")).not.toBeInTheDocument();
    expect(screen.queryByText("Groth16 verifier")).not.toBeInTheDocument();
    expect(screen.queryByText(/zero-knowledge guarantee/i)).not.toBeInTheDocument();
  });

  it("keeps ZK proof details for shielded actions", () => {
    render(<OnChainDetails txHash={txHash} onChain kind="shield" prover="local" provingMs={10120} />);

    fireEvent.click(screen.getByTestId("onchain-toggle"));

    expect(screen.getByText("Groth16 / BN254 · SHIELD")).toBeInTheDocument();
    expect(screen.getByText("Pool contract")).toBeInTheDocument();
    expect(screen.getByText("Groth16 verifier")).toBeInTheDocument();
    expect(screen.getByText(/zero-knowledge guarantee/i)).toBeInTheDocument();
    expect(screen.getByText("Local prover · 10.12s")).toBeInTheDocument();
  });
});
