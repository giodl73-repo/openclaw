import { describe, expect, it } from "vitest";
import { summarizeTrajectoryAuditRuns } from "./audit-run.js";
import type { TrajectoryEvent } from "./types.js";

function event(params: {
  type: string;
  seq: number;
  runId?: string;
  data?: Record<string, unknown>;
  provider?: string;
  modelId?: string;
}): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "session-1",
    source: "runtime",
    type: params.type,
    ts: `2026-07-14T12:00:${String(params.seq).padStart(2, "0")}.000Z`,
    seq: params.seq,
    sessionId: "session-1",
    sessionKey: "agent:main:email:thread:customer-1",
    runId: params.runId,
    provider: params.provider,
    modelId: params.modelId,
    data: params.data,
  };
}

describe("summarizeTrajectoryAuditRuns", () => {
  it("joins skill use, receipts, and summed model attempt usage by run", () => {
    const summaries = summarizeTrajectoryAuditRuns([
      event({ type: "session.started", seq: 1, runId: "run-1" }),
      event({
        type: "skill.invocation.started",
        seq: 2,
        runId: "run-1",
        data: {
          invocationId: "skill-1",
          commandName: "support",
          skillName: "customer-support",
          skillSource: "workspace",
        },
      }),
      event({
        type: "skill.used",
        seq: 3,
        runId: "run-1",
        data: { skillName: "customer-support", skillSource: "workspace", activation: "read" },
      }),
      event({
        type: "audit.receipt",
        seq: 4,
        runId: "run-1",
        data: {
          type: "case.updated",
          toolName: "dynamics",
          toolCallId: "call-1",
          regarding: { system: "dynamics", type: "case", id: "case-42" },
        },
      }),
      event({
        type: "model.completed",
        seq: 5,
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.6-luna",
        data: { usage: { input: 100, output: 20, cacheRead: 10, total: 130 } },
      }),
      event({
        type: "model.completed",
        seq: 6,
        runId: "run-1",
        provider: "openai",
        modelId: "gpt-5.6-luna",
        data: { usage: { input: 40, output: 5, total: 45 } },
      }),
      event({
        type: "skill.invocation.completed",
        seq: 7,
        runId: "run-1",
        data: { invocationId: "skill-1", status: "success" },
      }),
      event({ type: "session.ended", seq: 8, runId: "run-1", data: { status: "success" } }),
    ]);

    expect(summaries).toEqual([
      expect.objectContaining({
        auditSchema: "openclaw-audit-run",
        schemaVersion: 1,
        runId: "run-1",
        status: "success",
        models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
        usage: { input: 140, output: 25, cacheRead: 10, total: 175 },
        skillInvocations: [
          {
            invocationId: "skill-1",
            commandName: "support",
            skillName: "customer-support",
            skillSource: "workspace",
            status: "success",
          },
        ],
        skills: [{ skillName: "customer-support", skillSource: "workspace", activation: "read" }],
        receipts: [
          expect.objectContaining({
            type: "case.updated",
            regarding: { system: "dynamics", type: "case", id: "case-42" },
          }),
        ],
      }),
    ]);
  });

  it("selects runs and receipts by exact regarding identity", () => {
    const summaries = summarizeTrajectoryAuditRuns(
      [
        event({
          type: "audit.receipt",
          seq: 1,
          runId: "run-1",
          data: {
            type: "case.updated",
            regarding: { system: "dynamics", type: "case", id: "case-42" },
          },
        }),
        event({
          type: "audit.receipt",
          seq: 2,
          runId: "run-1",
          data: {
            type: "invoice.paid",
            regarding: { system: "dynamics", type: "case", id: "case-99" },
          },
        }),
        event({
          type: "audit.receipt",
          seq: 3,
          runId: "run-2",
          data: {
            type: "case.updated",
            regarding: { system: "dynamics", type: "case", id: "case-99" },
          },
        }),
      ],
      { type: "case.updated", regarding: { id: "case-42" } },
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.runId).toBe("run-1");
    expect(summaries[0]?.receipts).toEqual([
      expect.objectContaining({
        type: "case.updated",
        regarding: expect.objectContaining({ id: "case-42" }),
      }),
    ]);
  });

  it("ignores events without a run id and runs without auditable facts", () => {
    expect(
      summarizeTrajectoryAuditRuns([
        event({ type: "audit.receipt", seq: 1, data: { type: "case.updated" } }),
        event({ type: "session.started", seq: 2, runId: "run-2" }),
      ]),
    ).toEqual([]);
  });
});
