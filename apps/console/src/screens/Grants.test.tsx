import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Grants } from "./Grants";

const apiMock = vi.hoisted(() => ({
  createGrant: vi.fn(),
  periodTotalAttestation: vi.fn(),
  proveKyb: vi.fn(),
  revokeGrant: vi.fn(),
}));

const refreshMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../lib/api", () => ({ api: apiMock }));
vi.mock("../lib/store", () => ({
  useConsole: () => ({
    grants: [],
    accounts: [],
    refresh: refreshMock,
    loading: false,
  }),
}));

describe("Grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks blank viewing grants before calling the API", () => {
    render(<Grants />);

    fireEvent.click(screen.getByTestId("new-grant"));
    fireEvent.click(screen.getByTestId("grant-submit"));

    expect(apiMock.createGrant).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the auditor's name before issuing a grant.")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("grant-name"), { target: { value: "Codex Auditor" } });
    fireEvent.click(screen.getByTestId("grant-submit"));

    expect(apiMock.createGrant).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the auditor's public key before issuing a grant.")).toBeInTheDocument();
  });
});
