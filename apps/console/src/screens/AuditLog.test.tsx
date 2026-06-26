import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "./AuditLog";

const apiMock = vi.hoisted(() => {
  const packet = {
    orgId: "org_test",
    scope: { label: "console-private-events" },
    anchor: {
      orgId: "org_test",
      eventCount: 1,
      headHash: "head_hash",
      merkleRoot: "root_hash",
      anchoredAt: "2026-06-26T00:00:00.000Z",
    },
    envelopes: [
      {
        id: "pe_1",
        orgId: "org_test",
        type: "payment.submitted",
        subjectId: "po_1",
        schema: "payment.order.v1",
        occurredAt: "2026-06-26T00:00:00.000Z",
        publicMeta: { status: "needs_approval", source: "console" },
        ciphertext: "ciphertext",
        iv: "iv",
        tag: "tag",
        aadHash: "aad",
        payloadHash: "payload",
        prevHash: "GENESIS",
        hash: "head_hash",
      },
    ],
    inclusionProofs: [{ eventHash: "head_hash", siblings: [], index: 0 }],
    issuedAt: "2026-06-26T00:00:00.000Z",
  };
  return {
    ledger: vi.fn(async () => []),
    ledgerVerify: vi.fn(async () => ({ ok: true, length: 0 })),
    privateAuditPacket: vi.fn(async () => ({
      packet,
      integrity: { ok: true, headHash: "head_hash" },
      disclosure: "ciphertext-only; decrypt selected records with a scoped viewing key outside this API",
    })),
    anchorPrivateAuditRoot: vi.fn(async (body?: unknown) => ({
      packet,
      integrity: { ok: true, headHash: "head_hash" },
      packetHash: "packet_hash",
      orgHash: "org_hash",
      disclosure: "only roots/hashes/event counts are submitted on-chain; records remain ciphertext",
      anchor: { onChain: true, sequence: "123", txHash: "tx_hash" },
      ...(body ? { requestBody: body } : {}),
    })),
  };
});

vi.mock("../lib/api", () => ({ api: apiMock }));

describe("AuditLog private audit packet", () => {
  it("loads and anchors private audit packets through the hosted API", async () => {
    render(<AuditLog />);

    fireEvent.click(screen.getByTestId("load-private-audit"));

    await waitFor(() => expect(apiMock.privateAuditPacket).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("private-audit-result")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("anchor-private-audit"));

    await waitFor(() => expect(apiMock.anchorPrivateAuditRoot).toHaveBeenCalledOnce());
    expect(apiMock.anchorPrivateAuditRoot).toHaveBeenCalledWith({
      packet: expect.objectContaining({
        orgId: "org_test",
        anchor: expect.objectContaining({ eventCount: 1 }),
      }),
    });
  });
});
