import { describe, expect, it } from "vitest";
import {
  collectToolAuditReceipts,
  isTrajectoryAuditReceipt,
  MAX_AUDIT_RECEIPTS_PER_TOOL_RESULT,
} from "./audit.js";
import type { TrajectoryEvent } from "./types.js";

describe("collectToolAuditReceipts", () => {
  it("collects successful receipts that can be filtered by business type", () => {
    const { receipts } = collectToolAuditReceipts({
      toolCallId: "call-1",
      toolName: "payments.authorize",
      isError: false,
      result: {
        receipts: [
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
        result: { receipts: [{ type: "payment.authorized" }] },
      }),
    ).toEqual({ receipts: [], omittedCandidateCount: 0 });
  });

  it("drops an entire receipt when any producer field is malformed", () => {
    expect(
      collectToolAuditReceipts({
        toolCallId: "call-2",
        toolName: "inventory.send",
        isError: false,
        result: {
          receipts: [
            null,
            { type: "" },
            { type: " inventory.sent ", version: 0, subject: { type: "shipment" } },
          ],
        },
      }),
    ).toEqual({ receipts: [], omittedCandidateCount: 0 });
  });

  it("bounds receipt candidates admitted from one tool result", () => {
    const collected = collectToolAuditReceipts({
      toolCallId: "call-many",
      toolName: "inventory.send",
      isError: false,
      result: {
        receipts: Array.from({ length: MAX_AUDIT_RECEIPTS_PER_TOOL_RESULT + 3 }, (_, index) => ({
          type: `inventory.sent.${index}`,
        })),
      },
    });

    expect(collected.receipts).toHaveLength(MAX_AUDIT_RECEIPTS_PER_TOOL_RESULT);
    expect(collected.omittedCandidateCount).toBe(3);
  });
});

describe("isTrajectoryAuditReceipt", () => {
  const receiptEvent: TrajectoryEvent = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    type: "audit.receipt.recorded",
    ts: "2026-07-13T12:00:00.000Z",
    seq: 1,
    sessionId: "session-1",
    data: {
      type: "payment.authorized",
      receiptId: "rcpt-1",
    },
  };

  it("matches any valid receipt when no business type is requested", () => {
    expect(isTrajectoryAuditReceipt(receiptEvent)).toBe(true);
  });

  it("filters receipts by exact business type", () => {
    expect(isTrajectoryAuditReceipt(receiptEvent, "payment.authorized")).toBe(true);
    expect(isTrajectoryAuditReceipt(receiptEvent, "inventory.sent")).toBe(false);
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
