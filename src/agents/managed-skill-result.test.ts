import { describe, expect, it } from "vitest";
import type { RecordedAuditReceipt } from "../audit/receipt-store.sqlite.js";
import { buildManagedSkillRunResult } from "./managed-skill-result.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function managedRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "agent:main:main",
    task: "Resolve the case",
    cleanup: "keep",
    createdAt: 100,
    managedSkill: {
      invocationId: "skill-1",
      skillName: "resolve-case",
      skillDigest: "sha256:abc",
    },
    ...overrides,
  };
}

function receipt(overrides: Partial<RecordedAuditReceipt> = {}): RecordedAuditReceipt {
  return {
    receiptSchema: "openclaw-audit-receipt",
    schemaVersion: 1,
    sequence: 1,
    receiptId: "receipt-1",
    type: "case.resolved",
    occurredAt: 300,
    agentId: "main",
    sessionId: "child",
    runId: "run-1",
    invocationId: "skill-1",
    skillName: "resolve-case",
    skillDigest: "sha256:abc",
    toolName: "case.resolve",
    toolCallId: "call-1",
    ...overrides,
  };
}

describe("buildManagedSkillRunResult", () => {
  it("joins terminal native state and matching durable receipts", () => {
    const result = buildManagedSkillRunResult({
      run: managedRun({
        startedAt: 120,
        endedAt: 280,
        outcome: { status: "ok" },
      }),
      receipts: [receipt()],
    });

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        runId: "run-1",
        status: "completed",
        managedSkill: expect.objectContaining({ skillName: "resolve-case" }),
        receipts: [expect.objectContaining({ type: "case.resolved" })],
      }),
    });
  });

  it("uses native cancellation and failure state", () => {
    expect(
      buildManagedSkillRunResult({
        run: managedRun({
          endedAt: 280,
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          outcome: { status: "error" },
        }),
        receipts: [],
      }),
    ).toMatchObject({ ok: true, result: { status: "cancelled" } });
    expect(
      buildManagedSkillRunResult({
        run: managedRun({ endedAt: 280, outcome: { status: "timeout", error: "timed out" } }),
        receipts: [],
      }),
    ).toMatchObject({ ok: true, result: { status: "failed", error: "timed out" } });
  });

  it("reports unavailable identity instead of inferring it", () => {
    expect(
      buildManagedSkillRunResult({ run: managedRun({ managedSkill: undefined }), receipts: [] }),
    ).toEqual({ ok: false, code: "managed_identity_unavailable", runId: "run-1" });
  });

  it("rejects receipts correlated to another managed invocation", () => {
    expect(
      buildManagedSkillRunResult({
        run: managedRun(),
        receipts: [receipt({ invocationId: "skill-other" })],
      }),
    ).toEqual({ ok: false, code: "receipt_correlation_mismatch", runId: "run-1" });
  });
});
