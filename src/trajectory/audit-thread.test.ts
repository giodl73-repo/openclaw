import { describe, expect, it } from "vitest";
import { summarizeTrajectoryAuditThread } from "./audit-thread.js";
import type { TrajectoryEvent } from "./types.js";

function event(params: {
  type: string;
  seq: number;
  runId?: string;
  data?: Record<string, unknown>;
}): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "thread-1",
    source: "runtime",
    type: params.type,
    ts: `2026-07-14T12:00:${String(params.seq).padStart(2, "0")}.000Z`,
    seq: params.seq,
    sessionId: "session-1",
    sessionKey: "agent:main:email:thread:customer-1",
    runId: params.runId,
    data: params.data,
  };
}

describe("summarizeTrajectoryAuditThread", () => {
  it("reconstructs business events, outcome counts, and auditable runs", () => {
    const summary = summarizeTrajectoryAuditThread({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:email:thread:customer-1",
      regarding: { system: "dataverse", type: "case", id: "case-42", key: "CAS-42" },
      events: [
        event({
          type: "session.regarding.changed",
          seq: 1,
          data: {
            action: "set",
            current: { system: "dataverse", type: "case", id: "case-42", reference: "CAS-42" },
          },
        }),
        event({
          type: "skill.invocation.started",
          seq: 2,
          runId: "run-1",
          data: { invocationId: "inv-1", skillName: "customer-support" },
        }),
        event({
          type: "audit.receipt",
          seq: 3,
          runId: "run-1",
          data: {
            type: "customer.verified",
            regarding: { system: "dataverse", type: "case", id: "case-42" },
          },
        }),
        event({
          type: "audit.receipt",
          seq: 4,
          runId: "run-1",
          data: {
            type: "case.resolved",
            regarding: { system: "dataverse", type: "case", id: "case-42" },
            data: { resolutionCode: "SOLVED" },
          },
        }),
        event({
          type: "audit.receipt",
          seq: 5,
          runId: "run-1",
          data: {
            type: "customer.verified",
            regarding: { system: "dataverse", type: "case", id: "case-42" },
          },
        }),
        event({
          type: "model.completed",
          seq: 6,
          runId: "run-1",
          data: { usage: { input: 100, output: 20, total: 120 } },
        }),
      ],
    });

    expect(summary).toMatchObject({
      auditSchema: "openclaw-audit-thread",
      schemaVersion: 1,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:email:thread:customer-1",
      regarding: { system: "dataverse", type: "case", id: "case-42", key: "CAS-42" },
      firstEventAt: "2026-07-14T12:00:01.000Z",
      lastEventAt: "2026-07-14T12:00:06.000Z",
      outcomes: [
        { type: "case.resolved", count: 1 },
        { type: "customer.verified", count: 2 },
      ],
      businessEvents: [
        expect.objectContaining({ type: "session.regarding.changed" }),
        expect.objectContaining({ type: "audit.receipt", runId: "run-1" }),
        expect.objectContaining({ type: "audit.receipt", runId: "run-1" }),
        expect.objectContaining({ type: "audit.receipt", runId: "run-1" }),
      ],
      runs: [
        expect.objectContaining({
          runId: "run-1",
          usage: { input: 100, output: 20, total: 120 },
          skillInvocations: [
            expect.objectContaining({ invocationId: "inv-1", skillName: "customer-support" }),
          ],
        }),
      ],
    });
  });

  it("keeps a regarding thread discoverable before it records an outcome", () => {
    expect(
      summarizeTrajectoryAuditThread({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:email:thread:customer-1",
        regarding: { system: "dataverse", type: "case", id: "case-42" },
        events: [],
      }),
    ).toEqual({
      auditSchema: "openclaw-audit-thread",
      schemaVersion: 1,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:email:thread:customer-1",
      regarding: { system: "dataverse", type: "case", id: "case-42" },
      outcomes: [],
      businessEvents: [],
      runs: [],
    });
  });
});
