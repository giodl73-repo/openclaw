import { generateSecureToken } from "../infra/secure-random.js";
import type {
  ExplicitSkillInvocation,
  SkillExecutionHints,
  SkillTelemetrySource,
} from "./types.js";

/** Creates the shared identity recorded by prompt-backed and direct skill runs. */
export type CreateExplicitSkillInvocationParams = {
  commandName: string;
  skillName: string;
  skillSource?: SkillTelemetrySource;
  skillDigest?: string;
  executionHints?: SkillExecutionHints;
  parentInvocationId?: string;
  parentRunId?: string;
};

export function createExplicitSkillInvocation(
  params: CreateExplicitSkillInvocationParams,
): ExplicitSkillInvocation {
  return {
    invocationId: `skill_${generateSecureToken(8)}`,
    commandName: params.commandName,
    skillName: params.skillName,
    ...(params.skillSource ? { skillSource: params.skillSource } : {}),
    ...(params.skillDigest ? { skillDigest: params.skillDigest } : {}),
    ...(params.executionHints ? { executionHints: params.executionHints } : {}),
    ...(params.parentInvocationId ? { parentInvocationId: params.parentInvocationId } : {}),
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
  };
}
