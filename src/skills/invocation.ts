import { generateSecureToken } from "../infra/secure-random.js";
import type { SkillExecutionHints, SkillTelemetrySource } from "./types.js";

/** Durable identity assigned to one skill executed as a managed child run. */
export type ManagedSkillInvocation = {
  invocationId: string;
  skillName: string;
  skillSource?: SkillTelemetrySource;
  skillDigest?: string;
  executionHints?: SkillExecutionHints;
  parentRunId?: string;
};

export function createManagedSkillInvocation(params: {
  skillName: string;
  skillSource?: SkillTelemetrySource;
  skillDigest?: string;
  executionHints?: SkillExecutionHints;
  parentRunId?: string;
}): ManagedSkillInvocation {
  return {
    invocationId: `skill_${generateSecureToken(8)}`,
    skillName: params.skillName,
    ...(params.skillSource ? { skillSource: params.skillSource } : {}),
    ...(params.skillDigest ? { skillDigest: params.skillDigest } : {}),
    ...(params.executionHints ? { executionHints: params.executionHints } : {}),
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
  };
}
