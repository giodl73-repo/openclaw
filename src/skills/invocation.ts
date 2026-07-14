import { generateSecureToken } from "../infra/secure-random.js";
import type { ExplicitSkillInvocation, SkillTelemetrySource } from "./types.js";

/** Creates the shared identity recorded by prompt-backed and direct skill runs. */
export type CreateExplicitSkillInvocationParams = {
  commandName: string;
  skillName: string;
  skillSource?: SkillTelemetrySource;
  parentInvocationId?: string;
  parentRunId?: string;
};

export function createExplicitSkillInvocation(
  params: CreateExplicitSkillInvocationParams,
): ExplicitSkillInvocation {
  const parentLineage =
    params.parentInvocationId && params.parentRunId
      ? {
          parentInvocationId: params.parentInvocationId,
          parentRunId: params.parentRunId,
        }
      : {};
  return {
    invocationId: `skill_${generateSecureToken(8)}`,
    commandName: params.commandName,
    skillName: params.skillName,
    ...(params.skillSource ? { skillSource: params.skillSource } : {}),
    ...parentLineage,
  };
}
