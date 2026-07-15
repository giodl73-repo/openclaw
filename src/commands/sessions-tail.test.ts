// Sessions tail tests cover transcript tailing, filtering, and session-store setup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  resolveTrajectoryPointerFilePath,
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
} from "../trajectory/paths.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand, setSessionsTailFollowIntervalMsForTests } from "./sessions-tail.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

const sessionKey = "agent:main:telegram:direct:owner";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function makeEvent(
  params: Partial<TrajectoryEvent> & { type: string; ts: string },
): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    seq: 1,
    sessionId: "session-one",
    sessionKey,
    ...params,
  };
}

function writeJsonl(filePath: string, events: TrajectoryEvent[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function appendJsonl(filePath: string, event: TrajectoryEvent): void {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

function runtimeOutput(runtime: RuntimeEnv): string {
  return vi
    .mocked(runtime.log)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

async function waitForRuntimeOutput(
  runtime: RuntimeEnv,
  pattern: string,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!runtimeOutput(runtime).includes(pattern)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for output containing ${pattern}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

describe("sessionsTailCommand", () => {
  let tmpDir: string;
  let storePath: string;
  let trajectoryPath: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    setSessionsTailFollowIntervalMsForTests(10);
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-tail-"));
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        list: [{ id: "main" }, { id: "ops" }],
      },
    });
    storePath = path.join(tmpDir, "sessions.json");
    trajectoryPath = path.join(tmpDir, "session-one.trajectory.jsonl");
  });

  afterEach(() => {
    setSessionsTailFollowIntervalMsForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeSessionEntry(
    key = sessionKey,
    entry: Partial<SessionEntry> = {},
  ): Promise<void> {
    await replaceSessionEntry(
      { sessionKey: key, storePath },
      {
        sessionId: "session-one",
        sessionFile: "session-one.jsonl",
        updatedAt: 2,
        status: "running",
        ...entry,
      },
    );
  }

  async function appendEvents(
    events: TrajectoryEvent[],
    params: { key?: string; sessionId?: string } = {},
  ): Promise<void> {
    const targetPath =
      params.sessionId && params.sessionId !== "session-one"
        ? path.join(tmpDir, `${params.sessionId}.trajectory.jsonl`)
        : trajectoryPath;
    writeJsonl(
      targetPath,
      events.map((event) => ({ ...event, sessionKey: params.key ?? event.sessionKey })),
    );
  }

  it("renders compact redacted progress lines", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash", arguments: { command: "echo SECRET" } },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true, output: "SECRET" },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:29.000Z",
        provider: "openai",
        modelId: "gpt-5.2",
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("12:04:18");
    expect(output).toContain("tool.call");
    expect(output).toContain("bash {...redacted...}");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).toContain("model.completed");
    expect(output).toContain("openai/gpt-5.2 done");
    expect(output).not.toContain("SECRET");
  });

  it("honors the tail count before rendering existing trajectory events", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash" },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey, tail: "2" }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).not.toContain("session.started");
    expect(output).toContain("tool.call");
    expect(output).toContain("tool.result");
  });

  it("filters receipts by business type and emits their sanitized data as JSONL", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:18.000Z",
        data: {
          type: "inventory.sent",
          subject: { type: "shipment", id: "ship-1" },
        },
      }),
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:21.000Z",
        data: {
          type: "payment.authorized",
          subject: { type: "invoice", id: "inv-123" },
          data: { authorizationCode: "auth-456" },
        },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:22.000Z",
        data: { name: "payments.authorize", success: true },
      }),
    ]);

    await sessionsTailCommand(
      {
        store: storePath,
        sessionKey,
        receiptType: "payment.authorized",
        json: true,
        tail: "1",
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(output.data).toEqual({
      type: "payment.authorized",
      subject: { type: "invoice", id: "inv-123" },
      data: { authorizationCode: "auth-456" },
    });
  });

  it("filters receipts by snapshotted regarding identity before applying the tail limit", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:18.000Z",
        data: {
          type: "inventory.sent",
          regarding: { system: "dynamics", type: "case", id: "case-42" },
        },
      }),
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:20.000Z",
        data: {
          type: "payment.authorized",
          regarding: { system: "dynamics", type: "case", id: "case-99" },
        },
      }),
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:21.000Z",
        data: {
          type: "invoice.paid",
          regarding: {
            system: "dynamics",
            type: "case",
            id: "case-42",
            reference: "CAS-42",
          },
        },
      }),
    ]);

    await sessionsTailCommand(
      {
        store: storePath,
        sessionKey,
        regardingSystem: "dynamics",
        regardingType: "case",
        regardingId: "case-42",
        json: true,
        tail: "1",
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(output.data).toMatchObject({
      type: "invoice.paid",
      regarding: { system: "dynamics", type: "case", id: "case-42", reference: "CAS-42" },
    });
  });

  it("renders run-level audit summaries after applying receipt filters", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:18.000Z",
        runId: "run-1",
        data: {
          type: "case.updated",
          regarding: { system: "dynamics", type: "case", id: "case-42" },
        },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:19.000Z",
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.6-luna",
        data: { usage: { input: 100, output: 20, total: 120 } },
      }),
      makeEvent({
        type: "skill.used",
        ts: "2026-05-18T12:04:20.000Z",
        runId: "run-2",
        data: { skillName: "customer-support", skillSource: "workspace", activation: "read" },
      }),
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:21.000Z",
        runId: "run-2",
        data: {
          type: "invoice.paid",
          regarding: { system: "dynamics", type: "case", id: "case-42" },
        },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:22.000Z",
        runId: "run-2",
        provider: "openai",
        modelId: "gpt-5.6-luna",
        data: { usage: { input: 40, output: 5, total: 45 } },
      }),
    ]);

    await sessionsTailCommand(
      {
        store: storePath,
        sessionKey,
        auditRuns: true,
        regardingSystem: "dynamics",
        regardingType: "case",
        regardingId: "case-42",
        json: true,
        tail: "1",
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      auditSchema: "openclaw-audit-run",
      runId: "run-2",
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      usage: { input: 40, output: 5, total: 45 },
      skills: [{ skillName: "customer-support", skillSource: "workspace", activation: "read" }],
      receipts: [
        expect.objectContaining({
          type: "invoice.paid",
          regarding: { system: "dynamics", type: "case", id: "case-42" },
        }),
      ],
    });
  });

  it("includes explicit invocation outcomes in human audit summaries", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        type: "skill.invocation.started",
        ts: "2026-05-18T12:04:20.000Z",
        runId: "run-cli",
        data: {
          invocationId: "skill-1",
          commandName: "invoice-paid",
          skillName: "invoice-paid",
        },
      }),
      makeEvent({
        type: "skill.invocation.completed",
        ts: "2026-05-18T12:04:21.000Z",
        runId: "run-cli",
        data: {
          invocationId: "skill-1",
          commandName: "invoice-paid",
          skillName: "invoice-paid",
          status: "success",
        },
      }),
    ]);

    await sessionsTailCommand(
      { store: storePath, sessionKey, auditRuns: true, tail: "1" },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("invocations=invoice-paid:success"),
    );
  });

  it("reconstructs a queryable business thread with outcomes, evidence, and run spend", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry(sessionKey, {
      status: "idle",
      regarding: { system: "dataverse", type: "case", id: "case-42", key: "CAS-42" },
    });
    await appendEvents([
      makeEvent({
        type: "session.regarding.changed",
        ts: "2026-05-18T12:04:17.000Z",
        data: {
          action: "set",
          current: { system: "dataverse", type: "case", id: "case-42", reference: "CAS-42" },
        },
      }),
      makeEvent({
        type: "skill.invocation.started",
        ts: "2026-05-18T12:04:18.000Z",
        runId: "run-1",
        data: { invocationId: "inv-1", skillName: "customer-support" },
      }),
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:19.000Z",
        runId: "run-1",
        data: {
          type: "customer.verified",
          regarding: { system: "dataverse", type: "case", id: "case-42" },
        },
      }),
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:20.000Z",
        runId: "run-1",
        data: {
          type: "case.resolved",
          regarding: { system: "dataverse", type: "case", id: "case-42" },
          data: { resolutionCode: "SOLVED" },
        },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:21.000Z",
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.6-luna",
        data: { usage: { input: 100, output: 20, total: 120 } },
      }),
    ]);

    await sessionsTailCommand(
      {
        store: storePath,
        auditThread: true,
        sessionKey,
        json: true,
      },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      auditSchema: "openclaw-audit-thread",
      sessionKey,
      regarding: { system: "dataverse", type: "case", id: "case-42", key: "CAS-42" },
      outcomes: [
        { type: "case.resolved", count: 1 },
        { type: "customer.verified", count: 1 },
      ],
      businessEvents: [
        expect.objectContaining({ type: "session.regarding.changed" }),
        expect.objectContaining({
          type: "audit.receipt",
          data: expect.objectContaining({ type: "customer.verified" }),
        }),
        expect.objectContaining({
          type: "audit.receipt",
          data: expect.objectContaining({
            type: "case.resolved",
            data: { resolutionCode: "SOLVED" },
          }),
        }),
      ],
      runs: [
        expect.objectContaining({
          runId: "run-1",
          models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
          usage: { input: 100, output: 20, total: 120 },
        }),
      ],
    });
  });

  it("includes retained trajectories from rotated session ids in a thread audit", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry(sessionKey, {
      status: "idle",
      usageFamilySessionIds: ["session-old", "session-one"],
    });
    await appendEvents(
      [
        makeEvent({
          sessionId: "session-old",
          type: "audit.receipt",
          ts: "2026-05-18T12:04:19.000Z",
          runId: "run-old",
          data: { type: "customer.verified" },
        }),
      ],
      { sessionId: "session-old" },
    );
    await appendEvents([
      makeEvent({
        type: "audit.receipt",
        ts: "2026-05-18T12:04:20.000Z",
        runId: "run-current",
        data: { type: "case.resolved" },
      }),
    ]);

    await sessionsTailCommand(
      { store: storePath, auditThread: true, sessionKey, json: true },
      runtime,
    );

    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(output.firstEventAt).toBe("2026-05-18T12:04:19.000Z");
    expect(output.lastEventAt).toBe("2026-05-18T12:04:20.000Z");
    expect(output.businessEvents.map((event: { ts: string }) => event.ts)).toEqual([
      "2026-05-18T12:04:19.000Z",
      "2026-05-18T12:04:20.000Z",
    ]);
    expect(output.outcomes).toEqual([
      { type: "case.resolved", count: 1 },
      { type: "customer.verified", count: 1 },
    ]);
    expect(output.runs).toEqual([
      expect.objectContaining({ runId: "run-old" }),
      expect.objectContaining({ runId: "run-current" }),
    ]);
  });

  it("requires an explicit session for a thread audit", async () => {
    const runtime = makeRuntime();

    await sessionsTailCommand({ store: storePath, auditThread: true, json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith("--audit-thread requires --session-key.");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects follow mode for business-thread snapshots", async () => {
    const runtime = makeRuntime();

    await sessionsTailCommand(
      { store: storePath, auditThread: true, sessionKey, follow: true },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "--audit-thread does not support --follow; rerun the snapshot command as needed.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects following audit run summaries until incremental summaries are defined", async () => {
    const runtime = makeRuntime();

    await sessionsTailCommand(
      { store: storePath, sessionKey, auditRuns: true, follow: true },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "--audit-runs does not support --follow; rerun the snapshot command as needed.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("sums orchestration usage across parent and child session trajectories", async () => {
    const runtime = makeRuntime();
    const childSessionKey = "agent:main:subagent:child";
    await writeSessionEntry(sessionKey, {
      sessionId: "session-parent",
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-parent",
        storePath,
      }),
      updatedAt: Date.now() - 1,
      status: "idle",
    });
    await writeSessionEntry(childSessionKey, {
      sessionId: "session-child",
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-child",
        storePath,
      }),
      updatedAt: Date.now(),
      status: "idle",
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-parent", storePath }, [
      makeEvent({
        type: "skill.invocation.started",
        ts: "2026-05-18T12:04:18.000Z",
        runId: "run-parent",
        sessionId: "session-parent",
        data: { invocationId: "skill-parent", skillName: "customer-support" },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:19.000Z",
        runId: "run-parent",
        sessionId: "session-parent",
        data: { usage: { input: 20, output: 5, total: 25 } },
      }),
    ]);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-child", storePath }, [
      makeEvent({
        type: "skill.invocation.started",
        ts: "2026-05-18T12:04:20.000Z",
        runId: "run-child",
        sessionId: "session-child",
        data: {
          invocationId: "skill-child",
          parentInvocationId: "skill-parent",
          parentRunId: "run-parent",
          skillName: "issue-triage",
        },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:21.000Z",
        runId: "run-child",
        sessionId: "session-child",
        data: { usage: { input: 40, output: 10, total: 50 } },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, auditOrchestrations: true, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      auditSchema: "openclaw-audit-orchestration",
      accountingScope: "observed-runs",
      rootRunId: "run-parent",
      usage: { input: 60, output: 15, total: 75 },
      runs: [
        expect.objectContaining({ runId: "run-parent", sessionId: "session-parent" }),
        expect.objectContaining({
          runId: "run-child",
          sessionId: "session-child",
          parentRunId: "run-parent",
        }),
      ],
    });
  });

  it("does not expose general trajectory data through JSON output", async () => {
    const runtime = makeRuntime();

    await sessionsTailCommand({ store: storePath, sessionKey, json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--json requires --receipt-type or a --regarding-* filter so only sanitized audit receipts are emitted.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("rejects tail counts that exceed JavaScript safe integer precision", async () => {
    const runtime = makeRuntime();

    await sessionsTailCommand({ store: storePath, sessionKey, tail: "9007199254740992" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--tail must be a non-negative integer, for example --tail 25.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses a session trajectory pointer for relocated runtime files", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    const sessionFile = path.join(tmpDir, "session-one.jsonl");
    const relocatedDir = path.join(tmpDir, "relocated-trajectories");
    const relocatedTrajectoryPath = path.join(relocatedDir, "session-one.jsonl");
    fs.mkdirSync(relocatedDir, { recursive: true });
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-one",
        runtimeFile: relocatedTrajectoryPath,
      })}\n`,
    );
    writeJsonl(relocatedTrajectoryPath, [
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).not.toContain("No sessions found");
  });

  it("tails SQLite marker trajectory rows from the database", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry(sessionKey, {
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-one",
        storePath,
      }),
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "sqlite", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("sqlite ok");
    expect(output).not.toContain("No sessions found");
    expect(fs.existsSync(path.join(tmpDir, "trajectory", "session-one.jsonl"))).toBe(false);
  });

  it("ignores stale trajectory pointers for another session id", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    const sessionFile = path.join(tmpDir, "session-one.jsonl");
    const staleRuntimePath = path.join(tmpDir, "relocated-trajectories", "old-session.jsonl");
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "old-session",
        runtimeFile: staleRuntimePath,
      })}\n`,
    );
    writeJsonl(staleRuntimePath, [
      makeEvent({
        sessionId: "old-session",
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "stale", success: true },
      }),
    ]);
    await appendEvents([
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:22.000Z",
        data: { name: "current", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("current ok");
    expect(output).not.toContain("stale ok");
  });

  it("preserves events appended while follow mode starts", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" })]);
    const appendedEvent = makeEvent({
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "bash", success: true },
    });
    let appended = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!appended && String(message).includes("session.started")) {
        appended = true;
        appendJsonl(trajectoryPath, appendedEvent);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "bash ok");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("session.started");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
  });

  it("continues following when later trajectory events are appended", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const rewrittenEvent = makeEvent({
      sourceSeq: 2,
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "python", success: true },
    });
    let rewritten = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!rewritten && String(message).includes("session.started")) {
        rewritten = true;
        appendJsonl(trajectoryPath, rewrittenEvent);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "python ok");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("python ok");
  });

  it("continues following when SQLite trajectory rows are appended", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry(sessionKey, {
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-one",
        storePath,
      }),
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const appendedEvent = makeEvent({
      sourceSeq: 2,
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "sqlite", success: true },
    });
    let appended = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!appended && String(message).includes("session.started")) {
        appended = true;
        appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
          appendedEvent,
        ]);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "sqlite ok");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("sqlite ok");
  });

  it("resolves the target store from a fully qualified non-default agent session key", async () => {
    const runtime = makeRuntime();
    const opsSessionKey = "agent:ops:telegram:direct:owner";
    const opsSessionsDir = path.join(process.env.OPENCLAW_STATE_DIR!, "agents", "ops", "sessions");
    const opsStorePath = path.join(opsSessionsDir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey: opsSessionKey, storePath: opsStorePath },
      { sessionId: "ops-session", sessionFile: "ops-session.jsonl", updatedAt: 3, status: "done" },
    );
    writeJsonl(path.join(opsSessionsDir, "ops-session.trajectory.jsonl"), [
      makeEvent({
        sessionId: "ops-session",
        sessionKey: opsSessionKey,
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ sessionKey: opsSessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("agent:ops:telegram:direct:own…");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).not.toContain("No sessions found");
  });

  it("rejects oversized trajectory snapshots", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    fs.writeFileSync(trajectoryPath, "");
    fs.truncateSync(trajectoryPath, TRAJECTORY_RUNTIME_FILE_MAX_BYTES + 1);

    await expect(sessionsTailCommand({ store: storePath, sessionKey }, runtime)).rejects.toThrow(
      /File exceeds 52428800 bytes/,
    );
  });

  it("rejects oversized follow-mode trajectory deltas", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    writeJsonl(trajectoryPath, [
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
    ]);

    const run = sessionsTailCommand({ store: storePath, sessionKey, follow: true }, runtime);
    try {
      await waitForRuntimeOutput(runtime, "session.started");
      const initialSize = fs.statSync(trajectoryPath).size;
      fs.truncateSync(trajectoryPath, initialSize + TRAJECTORY_RUNTIME_FILE_MAX_BYTES + 1);
      await vi.waitFor(() => {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Trajectory delta exceeds 52428800 bytes"),
        );
      });
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }
  });
});
