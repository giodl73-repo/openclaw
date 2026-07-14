import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import {
  recordSessionRegardingTransition,
  resolveSessionRegardingTransition,
} from "./session-regarding-trajectory.js";

const caseRegarding = { system: "dynamics", type: "case", id: "case-42", key: "CAS-42" };
const caseReceipt = { system: "dynamics", type: "case", id: "case-42", reference: "CAS-42" };
const invoiceRegarding = { system: "dynamics", type: "invoice", id: "invoice-7" };

describe("session regarding trajectory", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-regarding-trajectory-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("classifies set, replace, clear, and unchanged values", () => {
    expect(resolveSessionRegardingTransition(undefined, caseRegarding)).toEqual({
      action: "set",
      regarding: caseReceipt,
    });
    expect(resolveSessionRegardingTransition(caseRegarding, invoiceRegarding)).toEqual({
      action: "replace",
      previous: caseReceipt,
      regarding: invoiceRegarding,
    });
    expect(resolveSessionRegardingTransition(caseRegarding, undefined)).toEqual({
      action: "clear",
      previous: caseReceipt,
    });
    expect(resolveSessionRegardingTransition(caseRegarding, { ...caseRegarding })).toBeNull();
  });

  it("records filterable set, replace, and clear events", async () => {
    const common = {
      actor: "crm-connector",
      agentId: "main",
      env: { OPENCLAW_TRAJECTORY: "1" },
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await expect(
      recordSessionRegardingTransition({ ...common, regarding: caseRegarding }),
    ).resolves.toBe(true);
    await expect(
      recordSessionRegardingTransition({
        ...common,
        previous: caseRegarding,
        regarding: invoiceRegarding,
      }),
    ).resolves.toBe(true);
    await expect(
      recordSessionRegardingTransition({ ...common, previous: invoiceRegarding }),
    ).resolves.toBe(true);

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        type: "session.regarding.changed",
        data: {
          action: "set",
          actor: "crm-connector",
          regarding: caseReceipt,
        },
      }),
      expect.objectContaining({
        type: "session.regarding.changed",
        data: {
          action: "replace",
          actor: "crm-connector",
          previous: caseReceipt,
          regarding: invoiceRegarding,
        },
      }),
      expect.objectContaining({
        type: "session.regarding.changed",
        data: {
          action: "clear",
          actor: "crm-connector",
          previous: invoiceRegarding,
        },
      }),
    ]);
  });

  it("does not record an unchanged value", async () => {
    await expect(
      recordSessionRegardingTransition({
        actor: "crm-connector",
        agentId: "main",
        env: { OPENCLAW_TRAJECTORY: "1" },
        previous: caseRegarding,
        regarding: { ...caseRegarding },
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toBe(false);
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
  });
});
