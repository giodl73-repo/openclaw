import { describe, expect, it } from "vitest";
import type { RecordedSkillMemory } from "../skill-memory/store.sqlite.js";
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

function memory(overrides: Partial<RecordedSkillMemory> = {}): RecordedSkillMemory {
  return {
    memorySchema: "openclaw-skill-memory",
    schemaVersion: 1,
    sequence: 1,
    memoryId: "smem_1",
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
  it("joins terminal native state and matching durable memories", () => {
    const result = buildManagedSkillRunResult({
      run: managedRun({
        startedAt: 120,
        endedAt: 280,
        outcome: { status: "ok" },
      }),
      memories: [memory()],
    });

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        runId: "run-1",
        status: "completed",
        managedSkill: expect.objectContaining({ skillName: "resolve-case" }),
        memories: [expect.objectContaining({ type: "case.resolved" })],
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
        memories: [],
      }),
    ).toMatchObject({ ok: true, result: { status: "cancelled" } });
    expect(
      buildManagedSkillRunResult({
        run: managedRun({ endedAt: 280, outcome: { status: "timeout", error: "timed out" } }),
        memories: [],
      }),
    ).toMatchObject({ ok: true, result: { status: "failed", error: "timed out" } });
  });

  it("reports unavailable identity instead of inferring it", () => {
    expect(
      buildManagedSkillRunResult({ run: managedRun({ managedSkill: undefined }), memories: [] }),
    ).toEqual({ ok: false, code: "managed_identity_unavailable", runId: "run-1" });
  });

  it.each([
    ["another invocation", { invocationId: "skill-other" }],
    ["missing managed identity", { invocationId: undefined, skillName: undefined }],
  ])("rejects memories correlated to %s", (_label, overrides) => {
    expect(
      buildManagedSkillRunResult({
        run: managedRun(),
        memories: [memory(overrides)],
      }),
    ).toEqual({ ok: false, code: "memory_correlation_mismatch", runId: "run-1" });
  });
});
