import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAuditReceiptStoresForTest,
  countAuditReceipts,
  getAuditReceipt,
  listAuditReceipts,
  recordAuditReceipt,
  resolveAuditReceiptStorePath,
} from "./receipt-store.sqlite.js";

describe("shared audit receipt store", () => {
  let tempDir: string;
  let databasePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-receipts-"));
    databasePath = path.join(tempDir, "shared", "receipts.sqlite");
  });

  afterEach(() => {
    closeAuditReceiptStoresForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function record(params: {
    agentId: string;
    receiptIndex?: number;
    receiptType: string;
    subject?: { type: string; id: string };
    data?: Record<string, unknown>;
  }) {
    return recordAuditReceipt(
      {
        receipt: {
          type: params.receiptType,
          ...(params.subject ? { subject: params.subject } : {}),
          ...(params.data ? { data: params.data } : {}),
        },
        receiptIndex: params.receiptIndex ?? 0,
        occurredAt: 1_700_000_000_000 + (params.receiptIndex ?? 0),
        agentId: params.agentId,
        sessionId: `session-${params.agentId}`,
        sessionKey: `agent:${params.agentId}:email:thread:customer-1`,
        runId: `run-${params.agentId}`,
        toolName: "business_action",
        toolCallId: `call-${params.agentId}`,
      },
      { path: databasePath },
    );
  }

  it("stores and filters outcomes shared by multiple agents", () => {
    record({
      agentId: "support",
      receiptType: "case.resolved",
      subject: { type: "case", id: "CAS-1042" },
    });
    record({
      agentId: "billing",
      receiptType: "payment.authorized",
      subject: { type: "invoice", id: "INV-1042" },
      data: { authorizationCode: "AUTH-9482" },
    });

    expect(
      listAuditReceipts({
        filters: { type: "payment.authorized" },
        limit: 10,
        store: { path: databasePath },
      }).receipts,
    ).toEqual([
      expect.objectContaining({
        receiptSchema: "openclaw-audit-receipt",
        type: "payment.authorized",
        agentId: "billing",
        subject: { type: "invoice", id: "INV-1042" },
        data: { authorizationCode: "AUTH-9482" },
      }),
    ]);
    expect(
      countAuditReceipts({
        filters: { subjectType: "case", subjectId: "CAS-1042" },
        store: { path: databasePath },
      }),
    ).toBe(1);
    const [payment] = listAuditReceipts({
      filters: { type: "payment.authorized" },
      limit: 1,
      store: { path: databasePath },
    }).receipts;
    expect(
      getAuditReceipt({ receiptId: payment!.receiptId, store: { path: databasePath } }),
    ).toEqual(payment);
  });

  it("pages stably and treats an empty agent filter as no agents", () => {
    record({ agentId: "support", receiptIndex: 0, receiptType: "case.resolved" });
    record({ agentId: "support", receiptIndex: 1, receiptType: "case.resolved" });
    record({ agentId: "support", receiptIndex: 2, receiptType: "case.resolved" });

    const first = listAuditReceipts({ limit: 2, store: { path: databasePath } });
    const second = listAuditReceipts({
      cursor: first.nextCursor,
      limit: 2,
      store: { path: databasePath },
    });

    expect(first.receipts.map((receipt) => receipt.sequence)).toEqual([3, 2]);
    expect(first.nextCursor).toBe(2);
    expect(second.receipts.map((receipt) => receipt.sequence)).toEqual([1]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      listAuditReceipts({
        filters: { agentIds: [] },
        limit: 10,
        store: { path: databasePath },
      }).receipts,
    ).toEqual([]);
  });

  it("deduplicates replay of the same trusted source", () => {
    const first = record({
      agentId: "support",
      receiptType: "case.resolved",
      data: { first: 1, second: 2 },
    });
    const replay = record({
      agentId: "support",
      receiptType: "case.resolved",
      data: { second: 2, first: 1 },
    });

    expect(replay.receiptId).toBe(first.receiptId);
    expect(countAuditReceipts({ store: { path: databasePath } })).toBe(1);
  });

  it("rejects changed content under the same trusted source identity", () => {
    record({ agentId: "support", receiptType: "case.resolved" });

    expect(() => record({ agentId: "support", receiptType: "case.closed" })).toThrow(
      "source identity was reused with different content",
    );
  });

  it("resolves an operator-configured SQLite path", () => {
    expect(
      resolveAuditReceiptStorePath({
        cfg: {
          audit: {
            receipts: { store: { type: "sqlite", path: databasePath } },
          },
        },
      }),
    ).toBe(path.resolve(databasePath));
  });
});
