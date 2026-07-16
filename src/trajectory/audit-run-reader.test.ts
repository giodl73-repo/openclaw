import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAuditReceiptStoresForTest,
  recordAuditReceipt,
} from "../audit/receipt-store.sqlite.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readTrajectoryAuditRun } from "./audit-run-reader.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

describe("trajectory audit run reader", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-run-reader-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:subagent:verify", storePath },
      { sessionId: "session-verify", updatedAt: 10 },
    );
  });

  afterEach(() => {
    closeAuditReceiptStoresForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("projects receipts and token usage for one persisted run", () => {
    const receiptStorePath = path.join(tempDir, "shared", "receipts.sqlite");
    const cfg = {
      session: { store: storePath },
      audit: { receipts: { store: { type: "sqlite" as const, path: receiptStorePath } } },
    };
    const recorded = recordAuditReceipt(
      {
        receipt: {
          type: "customer.verified",
          subject: { type: "case", id: "CAS-42" },
          data: { verificationId: "VER-42" },
        },
        receiptIndex: 0,
        occurredAt: Date.parse("2026-07-15T00:00:00.000Z"),
        agentId: "main",
        sessionId: "session-verify",
        sessionKey: "agent:main:subagent:verify",
        runId: "run-verify",
        toolName: "customer_lookup",
        toolCallId: "call-verify",
      },
      { cfg },
    );
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-verify", storePath }, [
      event("model.completed", {
        usage: { input: 40, output: 10, total: 50 },
      }),
      event("audit.receipt.recorded", {
        receiptId: recorded.receiptId,
        type: "customer.verified",
        subject: { type: "case", id: "CAS-42" },
        toolCallId: "call-verify",
        toolName: "customer_lookup",
      }),
      event("session.ended", { status: "ok" }),
    ]);

    expect(
      readTrajectoryAuditRun({
        cfg,
        runId: "run-verify",
        sessionKey: "agent:main:subagent:verify",
      }),
    ).toMatchObject({
      auditSchema: "openclaw-audit-run",
      runId: "run-verify",
      status: "ok",
      usage: { input: 40, output: 10, total: 50 },
      receipts: [
        {
          type: "customer.verified",
          subject: { type: "case", id: "CAS-42" },
          data: { verificationId: "VER-42" },
        },
      ],
    });
  });

  function event(type: string, data: Record<string, unknown>): TrajectoryEvent {
    return {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: "session-verify",
      source: "runtime",
      type,
      ts: "2026-07-15T00:00:00.000Z",
      seq: 1,
      sourceSeq: 1,
      sessionId: "session-verify",
      sessionKey: "agent:main:subagent:verify",
      runId: "run-verify",
      data,
    };
  }
});
