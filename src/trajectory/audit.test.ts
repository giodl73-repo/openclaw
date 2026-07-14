import { describe, expect, it } from "vitest";
import {
  collectToolAuditReceipts,
  isTrajectoryAuditReceipt,
  matchesTrajectoryAuditReceipt,
  snapshotAuditReceiptRegarding,
} from "./audit.js";
import type { TrajectoryEvent } from "./types.js";

describe("collectToolAuditReceipts", () => {
  it("collects successful receipts that can be filtered by business type", () => {
    const receipts = collectToolAuditReceipts({
      toolCallId: "call-1",
      toolName: "payments.authorize",
      isError: false,
      result: {
        audit: [
          {
            type: "inventory.sent",
            subject: { type: "shipment", id: "ship-1" },
          },
          {
            type: "payment.authorized",
            version: 1,
            subject: { type: "invoice", id: "inv-123" },
            data: { authorizationCode: "auth-456" },
          },
        ],
      },
    });

    expect(receipts.filter((receipt) => receipt.type === "payment.authorized")).toEqual([
      {
        type: "payment.authorized",
        version: 1,
        subject: { type: "invoice", id: "inv-123" },
        data: { authorizationCode: "auth-456" },
        toolCallId: "call-1",
        toolName: "payments.authorize",
      },
    ]);
  });

  it("does not record failed tool results", () => {
    expect(
      collectToolAuditReceipts({
        toolCallId: "call-1",
        toolName: "payments.authorize",
        isError: true,
        result: { audit: [{ type: "payment.authorized" }] },
      }),
    ).toEqual([]);
  });

  it("drops malformed records while retaining valid filter keys", () => {
    expect(
      collectToolAuditReceipts({
        toolCallId: "call-2",
        toolName: "inventory.send",
        isError: false,
        result: {
          audit: [
            null,
            { type: "" },
            { type: " inventory.sent ", version: 0, subject: { type: "shipment" } },
          ],
        },
      }),
    ).toEqual([
      {
        type: "inventory.sent",
        toolCallId: "call-2",
        toolName: "inventory.send",
      },
    ]);
  });
});

describe("isTrajectoryAuditReceipt", () => {
  const receiptEvent: TrajectoryEvent = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    type: "audit.receipt",
    ts: "2026-07-13T12:00:00.000Z",
    seq: 1,
    sessionId: "session-1",
    data: {
      type: "payment.authorized",
      data: { authorizationCode: "auth-456" },
      regarding: { system: "dynamics", type: "case", id: "case-42", reference: "CAS-42" },
    },
  };

  it("matches any valid receipt when no business type is requested", () => {
    expect(isTrajectoryAuditReceipt(receiptEvent)).toBe(true);
  });

  it("filters receipts by exact business type", () => {
    expect(isTrajectoryAuditReceipt(receiptEvent, "payment.authorized")).toBe(true);
    expect(isTrajectoryAuditReceipt(receiptEvent, "inventory.sent")).toBe(false);
  });

  it("filters receipts by exact snapshotted regarding identity", () => {
    expect(
      matchesTrajectoryAuditReceipt(receiptEvent, {
        regarding: { system: "dynamics", type: "case", id: "case-42" },
      }),
    ).toBe(true);
    expect(
      matchesTrajectoryAuditReceipt(receiptEvent, {
        regarding: { type: "invoice" },
      }),
    ).toBe(false);
    expect(
      matchesTrajectoryAuditReceipt(receiptEvent, {
        type: "inventory.sent",
        regarding: { id: "case-42" },
      }),
    ).toBe(false);
  });

  it("rejects non-receipt and untyped events", () => {
    expect(isTrajectoryAuditReceipt({ ...receiptEvent, type: "tool.result" })).toBe(false);
    expect(
      isTrajectoryAuditReceipt({
        ...receiptEvent,
        data: { data: { authorizationCode: "auth-456" } },
      }),
    ).toBe(false);
  });
});

describe("snapshotAuditReceiptRegarding", () => {
  it("adds a receipt-safe snapshot without changing the source receipt", () => {
    const receipt = collectToolAuditReceipts({
      toolCallId: "call-1",
      toolName: "payments.authorize",
      isError: false,
      result: { audit: [{ type: "payment.authorized" }] },
    })[0]!;

    expect(
      snapshotAuditReceiptRegarding(receipt, {
        system: "dynamics",
        type: "case",
        id: "case-42",
        key: "CAS-42",
      }),
    ).toEqual({
      ...receipt,
      regarding: {
        system: "dynamics",
        type: "case",
        id: "case-42",
        reference: "CAS-42",
      },
    });
    expect(receipt).not.toHaveProperty("regarding");
  });
});
