import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { collectAttemptToolAuditReceipts } from "./attempt-audit-receipts.js";

describe("collectAttemptToolAuditReceipts", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-receipt-regarding-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      {
        sessionId: "session-1",
        updatedAt: 10,
        regarding: { system: "dynamics", type: "case", id: "case-42", key: "CAS-42" },
      },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("snapshots the latest session regarding identity onto every valid receipt", async () => {
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "session-1",
      storePath,
    });

    expect(
      collectAttemptToolAuditReceipts({
        agentId: "main",
        attempt: {
          sessionFile,
          sessionId: "session-1",
          sessionKey: "agent:main:main",
        },
        event: {
          toolCallId: "call-1",
          toolName: "payments.authorize",
          isError: false,
          result: {
            audit: [{ type: "payment.authorized" }, { type: "invoice.paid" }],
          },
        },
      }),
    ).toEqual([
      {
        type: "payment.authorized",
        toolCallId: "call-1",
        toolName: "payments.authorize",
        regarding: {
          system: "dynamics",
          type: "case",
          id: "case-42",
          reference: "CAS-42",
        },
      },
      {
        type: "invoice.paid",
        toolCallId: "call-1",
        toolName: "payments.authorize",
        regarding: {
          system: "dynamics",
          type: "case",
          id: "case-42",
          reference: "CAS-42",
        },
      },
    ]);

    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      {
        sessionId: "session-1",
        updatedAt: 20,
        regarding: { system: "erp", type: "invoice", id: "invoice-7" },
      },
    );
    expect(
      collectAttemptToolAuditReceipts({
        agentId: "main",
        attempt: { sessionFile, sessionId: "session-1", sessionKey: "agent:main:main" },
        event: {
          toolCallId: "call-2",
          toolName: "invoices.pay",
          isError: false,
          result: { audit: [{ type: "invoice.paid" }] },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        regarding: { system: "erp", type: "invoice", id: "invoice-7" },
      }),
    ]);
  });

  it("does not copy regarding from a replacement session", async () => {
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "session-1",
      storePath,
    });
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      {
        sessionId: "session-2",
        updatedAt: 20,
        regarding: { system: "dynamics", type: "case", id: "case-99" },
      },
    );

    expect(
      collectAttemptToolAuditReceipts({
        agentId: "main",
        attempt: { sessionFile, sessionId: "session-1", sessionKey: "agent:main:main" },
        event: {
          toolCallId: "call-late",
          toolName: "payments.authorize",
          isError: false,
          result: { audit: [{ type: "payment.authorized" }] },
        },
      }),
    ).toEqual([
      {
        type: "payment.authorized",
        toolCallId: "call-late",
        toolName: "payments.authorize",
      },
    ]);
  });

  it("does not read session context when the tool result has no valid receipts", () => {
    expect(
      collectAttemptToolAuditReceipts({
        agentId: "main",
        attempt: {
          sessionFile: "not-a-session-file",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
        },
        event: {
          toolCallId: "call-1",
          toolName: "payments.authorize",
          isError: true,
          result: { audit: [{ type: "payment.authorized" }] },
        },
      }),
    ).toEqual([]);
  });
});
