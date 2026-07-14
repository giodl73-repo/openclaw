import { generateSecureToken } from "../infra/secure-random.js";
import type {
  ExplicitSkillInvocation,
  SkillOrchestrationDeclarationV1,
  SkillTelemetrySource,
} from "./types.js";

/** Creates the shared identity recorded by prompt-backed and direct skill runs. */
export type CreateExplicitSkillInvocationParams = {
  commandName: string;
  skillName: string;
  skillSource?: SkillTelemetrySource;
  skillDigest?: string;
  orchestration?: SkillOrchestrationDeclarationV1;
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
    ...(params.orchestration ? { orchestration: params.orchestration } : {}),
  };
}
