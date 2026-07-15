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
          skillDigest: `sha256:${"a".repeat(64)}`,
          executionHints: {
            outcomes: ["case.updated"],
          },
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
          toolName: "support-crm",
          toolCallId: "call-1",
          subject: { type: "case", id: "case-42" },
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
            skillDigest: `sha256:${"a".repeat(64)}`,
            executionHints: {
              outcomes: ["case.updated"],
            },
            status: "success",
          },
        ],
        skills: [{ skillName: "customer-support", skillSource: "workspace", activation: "read" }],
        receipts: [
          expect.objectContaining({
            type: "case.updated",
            subject: { type: "case", id: "case-42" },
          }),
        ],
      }),
    ]);
  });

  it("selects runs and receipts by exact outcome type", () => {
    const summaries = summarizeTrajectoryAuditRuns(
      [
        event({
          type: "audit.receipt",
          seq: 1,
          runId: "run-1",
          data: {
            type: "case.updated",
            subject: { type: "case", id: "case-42" },
          },
        }),
        event({
          type: "audit.receipt",
          seq: 2,
          runId: "run-1",
          data: {
            type: "invoice.paid",
            subject: { type: "invoice", id: "invoice-99" },
          },
        }),
        event({
          type: "audit.receipt",
          seq: 3,
          runId: "run-2",
          data: {
            type: "inventory.sent",
            subject: { type: "inventory", id: "inventory-99" },
          },
        }),
      ],
      "case.updated",
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.runId).toBe("run-1");
    expect(summaries[0]?.receipts).toEqual([
      expect.objectContaining({
        type: "case.updated",
        subject: { type: "case", id: "case-42" },
      }),
    ]);
  });

  it("exposes child skill lineage without rolling child usage into the parent run", () => {
    const summaries = summarizeTrajectoryAuditRuns([
      event({
        type: "skill.invocation.started",
        seq: 1,
        runId: "run-parent",
        data: {
          invocationId: "skill-parent",
          skillName: "customer-support",
        },
      }),
      event({
        type: "model.completed",
        seq: 2,
        runId: "run-parent",
        data: { usage: { input: 20, output: 5, total: 25 } },
      }),
      event({
        type: "skill.invocation.started",
        seq: 3,
        runId: "run-child",
        data: {
          invocationId: "skill-child",
          parentInvocationId: "skill-parent",
          parentRunId: "run-parent",
          skillName: "issue-triage",
        },
      }),
      event({
        type: "model.completed",
        seq: 4,
        runId: "run-child",
        data: { usage: { input: 40, output: 10, total: 50 } },
      }),
      event({
        type: "skill.invocation.completed",
        seq: 5,
        runId: "run-child",
        data: {
          invocationId: "skill-child",
          parentInvocationId: "skill-parent",
          parentRunId: "run-parent",
          status: "success",
        },
      }),
      event({
        type: "session.ended",
        seq: 6,
        runId: "run-child",
        data: { status: "success" },
      }),
    ]);

    expect(summaries).toEqual([
      expect.objectContaining({
        runId: "run-parent",
        usage: { input: 20, output: 5, total: 25 },
        skillInvocations: [
          {
            invocationId: "skill-parent",
            skillName: "customer-support",
          },
        ],
      }),
      expect.objectContaining({
        runId: "run-child",
        status: "success",
        usage: { input: 40, output: 10, total: 50 },
        skillInvocations: [
          {
            invocationId: "skill-child",
            parentInvocationId: "skill-parent",
            parentRunId: "run-parent",
            skillName: "issue-triage",
            status: "success",
          },
        ],
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
