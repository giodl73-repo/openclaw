import { describe, expect, it } from "vitest";
import { collectToolAuditReceipts } from "./audit.js";

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
