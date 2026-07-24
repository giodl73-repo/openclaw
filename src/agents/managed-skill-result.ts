import type { RecordedSkillMemory } from "../skill-memory/store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

export type ManagedSkillRunResult = {
  runId: string;
  childSessionKey: string;
  managedSkill: NonNullable<SubagentRunRecord["managedSkill"]>;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  memories: RecordedSkillMemory[];
};

export type ManagedSkillRunResultResolution =
  | { ok: true; result: ManagedSkillRunResult }
  | {
      ok: false;
      code: "managed_identity_unavailable" | "memory_correlation_mismatch";
      runId: string;
    };

function normalizeManagedRunStatus(run: SubagentRunRecord): ManagedSkillRunResult["status"] {
  const status = resolveSubagentSessionStatus(run);
  if (status === "running") {
    return "running";
  }
  if (status === "killed") {
    return "cancelled";
  }
  if (status === "failed" || status === "timeout") {
    return "failed";
  }
  return "completed";
}

/** Builds one runner-neutral result from native run identity and durable memories. */
export function buildManagedSkillRunResult(params: {
  run: SubagentRunRecord;
  memories: RecordedSkillMemory[];
}): ManagedSkillRunResultResolution {
  const { run } = params;
  const managedSkill = run.managedSkill;
  if (!managedSkill) {
    return { ok: false, code: "managed_identity_unavailable", runId: run.runId };
  }
  const memoryMismatch = params.memories.some(
    (memory) =>
      memory.runId !== run.runId ||
      (memory.invocationId !== undefined && memory.invocationId !== managedSkill.invocationId) ||
      (memory.skillName !== undefined && memory.skillName !== managedSkill.skillName) ||
      (memory.skillDigest !== undefined && memory.skillDigest !== managedSkill.skillDigest),
  );
  if (memoryMismatch) {
    return { ok: false, code: "memory_correlation_mismatch", runId: run.runId };
  }
  return {
    ok: true,
    result: {
      runId: run.runId,
      childSessionKey: run.childSessionKey,
      managedSkill,
      status: normalizeManagedRunStatus(run),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.outcome?.error ? { error: run.outcome.error } : {}),
      memories: params.memories,
    },
  };
}
