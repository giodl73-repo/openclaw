import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { summarizeTrajectoryAuditRuns } from "./audit-run.js";
import { createDirectSkillInvocationAudit } from "./direct-skill-invocation.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";

describe("direct skill invocation audit", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-direct-skill-audit-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:email:customer-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records a direct call, business receipt, and no model spend", async () => {
    const audit = createDirectSkillInvocationAudit({
      agentId: "main",
      config: {},
      env: { OPENCLAW_TRAJECTORY: "1" },
      invocation: {
        invocationId: "skill-1",
        commandName: "pay_invoice",
        skillName: "invoice-payment",
        skillSource: "workspace",
      },
      regarding: { system: "dynamics", type: "case", id: "case-42", key: "CAS-42" },
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:email:customer-1",
      storePath,
      toolCallId: "call-1",
      toolName: "payments",
    });
    expect(audit).not.toBeNull();

    audit?.recordUse();
    audit?.recordResult(
      {
        audit: [
          {
            type: "payment.authorized",
            subject: { type: "invoice", id: "invoice-7" },
            data: { authorizationCode: "AUTH-123" },
          },
        ],
      },
      false,
    );
    await audit?.complete("success");

    const events = await loadSqliteTrajectoryRuntimeEvents({
      sessionId: "session-1",
      storePath,
    });
    expect(events.map((event) => event.type)).toEqual([
      "skill.invocation.started",
      "skill.used",
      "audit.receipt",
      "skill.invocation.completed",
    ]);
    expect(summarizeTrajectoryAuditRuns(events)).toEqual([
      expect.objectContaining({
        runId: "run-1",
        status: "success",
        models: [],
        skillInvocations: [
          expect.objectContaining({
            invocationId: "skill-1",
            toolName: "payments",
            toolCallId: "call-1",
            status: "success",
          }),
        ],
        receipts: [
          expect.objectContaining({
            type: "payment.authorized",
            data: { authorizationCode: "AUTH-123" },
            regarding: {
              system: "dynamics",
              type: "case",
              id: "case-42",
              reference: "CAS-42",
            },
          }),
        ],
      }),
    ]);
    expect(summarizeTrajectoryAuditRuns(events)[0]).not.toHaveProperty("usage");
  });
});
