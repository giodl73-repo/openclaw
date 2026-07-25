import type { AgentToolMemory } from "../../packages/agent-core/src/types.js";
import type { TrajectoryEvent } from "./types.js";

export type ObservedToolMemoryResult = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

export type TrajectorySkillMemory = AgentToolMemory & {
  toolCallId: string;
  toolName: string;
};

const MEMORY_TYPE_MAX_CHARS = 256;
const MEMORY_SUBJECT_TYPE_MAX_CHARS = 256;
const MEMORY_SUBJECT_ID_MAX_CHARS = 2_048;
export const MAX_SKILL_MEMORY_PER_TOOL_RESULT = 16;

export type CollectedToolSkillMemory = {
  memories: TrajectorySkillMemory[];
  omittedCandidateCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSubject(value: unknown): AgentToolMemory["subject"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return type &&
    type.length <= MEMORY_SUBJECT_TYPE_MAX_CHARS &&
    id &&
    id.length <= MEMORY_SUBJECT_ID_MAX_CHARS
    ? { type, id }
    : undefined;
}

function normalizeSkillMemory(value: unknown): AgentToolMemory | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (!type || type.length > MEMORY_TYPE_MAX_CHARS) {
    return undefined;
  }
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : undefined;
  if ("version" in value && version === undefined) {
    return undefined;
  }
  const subject = normalizeSubject(value.subject);
  if ("subject" in value && subject === undefined) {
    return undefined;
  }
  const data = isRecord(value.data) ? value.data : undefined;
  if ("data" in value && data === undefined) {
    return undefined;
  }
  return {
    type,
    ...(version === undefined ? {} : { version }),
    ...(subject ? { subject } : {}),
    ...(data ? { data } : {}),
  };
}

/** Returns whether a trajectory event references a recorded memory of an optional exact type. */
export function isTrajectorySkillMemory(event: TrajectoryEvent, memoryType?: string): boolean {
  if (event.type !== "skill.memory.remembered") {
    return false;
  }
  const eventMemoryType = typeof event.data?.type === "string" ? event.data.type.trim() : "";
  if (!eventMemoryType) {
    return false;
  }
  const expectedType = memoryType?.trim();
  return !expectedType || eventMemoryType === expectedType;
}

/**
 * Reads Skill Memory entries from a successful, already-sanitized tool observation.
 * Session, run, model, and timestamp correlation are added by the trajectory recorder.
 */
export function collectToolSkillMemory(event: ObservedToolMemoryResult): CollectedToolSkillMemory {
  if (event.isError || !isRecord(event.result) || !Array.isArray(event.result.memories)) {
    return { memories: [], omittedCandidateCount: 0 };
  }
  const memories: TrajectorySkillMemory[] = [];
  const candidates = event.result.memories.slice(0, MAX_SKILL_MEMORY_PER_TOOL_RESULT);
  for (const candidate of candidates) {
    const record = normalizeSkillMemory(candidate);
    if (!record) {
      continue;
    }
    memories.push({
      ...record,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  return {
    memories,
    omittedCandidateCount: Math.max(0, event.result.memories.length - candidates.length),
  };
}
