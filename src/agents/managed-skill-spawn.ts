import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createManagedSkillInvocation } from "../skills/invocation.js";
import { resolveSkillTelemetrySource } from "../skills/loading/source.js";
import type { SkillSnapshot } from "../skills/types.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
  type SpawnSubagentResult,
} from "./subagent-spawn.js";

export type SpawnManagedSkillParams = Omit<SpawnSubagentParams, "managedSkill" | "task"> & {
  skillName: string;
  task: string;
  runtime?: "subagent" | "acp";
  visible?: boolean;
};

export type SpawnManagedSkillContext = SpawnSubagentContext & {
  /** Trusted effective skills for the parent run. */
  skillsSnapshot?: SkillSnapshot;
  /** Trusted identifier for the parent agent run. */
  parentRunId?: string;
};

/**
 * Dispatch one managed skill through the native subagent lifecycle.
 * Host controllers call this boundary instead of reproducing skill admission.
 */
export async function spawnManagedSkillDirect(
  params: SpawnManagedSkillParams,
  ctx: SpawnManagedSkillContext,
): Promise<SpawnSubagentResult> {
  const { skillsSnapshot, parentRunId, ...spawnContext } = ctx;
  const skillName = params.skillName.trim();
  const availableSkillNames = new Set(
    (skillsSnapshot?.skills ?? []).map((skill) => skill.name.trim()),
  );
  const matchingSkills = (skillsSnapshot?.resolvedSkills ?? []).filter(
    (skill) =>
      skill.name.trim() === skillName &&
      availableSkillNames.has(skill.name.trim()) &&
      !skill.disableModelInvocation,
  );
  if (matchingSkills.length !== 1) {
    return {
      status: "error",
      error:
        matchingSkills.length === 0
          ? `Skill "${skillName}" is not available in this run.`
          : `Skill "${skillName}" is ambiguous in this run.`,
    };
  }

  const requesterAgentId = normalizeAgentId(
    spawnContext.requesterAgentIdOverride ??
      resolveAgentIdFromSessionKey(spawnContext.agentSessionKey),
  );
  if (params.agentId && normalizeAgentId(params.agentId) !== requesterAgentId) {
    return {
      status: "error",
      error: "Managed skill invocation currently requires the child to use the current agent.",
    };
  }
  if (params.runtime === "acp") {
    return {
      status: "error",
      error: 'Managed skill invocation currently requires runtime="subagent".',
    };
  }
  if (params.mode === "session" || params.thread === true || params.visible === true) {
    return {
      status: "error",
      error:
        'Managed skill invocation is one background run; omit visible and thread, and use mode="run".',
    };
  }

  const requestedSkill = matchingSkills[0];
  const snapshotSkill = skillsSnapshot?.skills.find((skill) => skill.name.trim() === skillName);
  const managedSkill = createManagedSkillInvocation({
    skillName: requestedSkill.name,
    skillSource: resolveSkillTelemetrySource(requestedSkill),
    skillDigest: requestedSkill.contentDigest ?? snapshotSkill?.skillDigest,
    executionHints: snapshotSkill?.executionHints,
    parentRunId,
  });
  const {
    runtime: _runtime,
    skillName: _skillName,
    task,
    thread: _thread,
    visible: _visible,
    ...spawnParams
  } = params;

  return await spawnSubagentDirect(
    {
      ...spawnParams,
      task: `Use the ${requestedSkill.name} skill to complete this task:\n\n${task}`,
      managedSkill,
    },
    spawnContext,
  );
}
