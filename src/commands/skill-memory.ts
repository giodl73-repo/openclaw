/** Local operator recall surface for durable Skill Memory entries. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getRuntimeConfig } from "../config/config.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  countSkillMemory,
  getSkillMemory,
  listSkillMemory,
  type SkillMemoryFilters,
  type RecordedSkillMemory,
} from "../skill-memory/store.sqlite.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export type SkillMemoryCommandOptions = {
  id?: string;
  count?: boolean;
  type?: string;
  subjectType?: string;
  subjectId?: string;
  agent?: string;
  session?: string;
  run?: string;
  limit?: string;
  cursor?: string;
  json?: boolean;
};

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parsePositive(value: string | undefined, flag: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  const parsed = parseStrictPositiveInteger(value ?? "");
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function buildFilters(options: SkillMemoryCommandOptions): SkillMemoryFilters {
  const subjectType = optionalTrimmed(options.subjectType);
  const subjectId = optionalTrimmed(options.subjectId);
  if (subjectId && !subjectType) {
    throw new Error("--subject-id requires --subject-type.");
  }
  const agentIds = optionalTrimmed(options.agent)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    ...(optionalTrimmed(options.type) ? { type: options.type!.trim() } : {}),
    ...(subjectType ? { subjectType } : {}),
    ...(subjectId ? { subjectId } : {}),
    ...(agentIds ? { agentIds } : {}),
    ...(optionalTrimmed(options.session) ? { sessionKey: options.session!.trim() } : {}),
    ...(optionalTrimmed(options.run) ? { runId: options.run!.trim() } : {}),
  };
}

function formatMemory(memory: RecordedSkillMemory): string {
  const subject = memory.subject ? ` ${memory.subject.type}:${memory.subject.id}` : "";
  return sanitizeTerminalText(
    `${timestampMsToIsoString(memory.occurredAt) ?? memory.occurredAt} ${memory.type}${subject} ${memory.memoryId} agent=${memory.agentId} session=${memory.sessionKey ?? memory.sessionId} run=${memory.runId}`,
  );
}

/** Get, list, or count memories in the configured single-host store. */
export async function skillMemoryCommand(
  options: SkillMemoryCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const memoryId = optionalTrimmed(options.id);
  if (memoryId) {
    if (
      options.count ||
      options.cursor ||
      options.limit ||
      options.type ||
      options.subjectType ||
      options.subjectId ||
      options.agent ||
      options.session ||
      options.run
    ) {
      throw new Error("--id cannot be combined with list or count filters.");
    }
    const memory = getSkillMemory({ memoryId, store: { cfg } });
    if (!memory) {
      throw new Error(`memory not found: ${memoryId}`);
    }
    writeRuntimeJson(runtime, memory);
    return;
  }

  const filters = buildFilters(options);
  if (options.count) {
    if (options.cursor || options.limit) {
      throw new Error("--count cannot be combined with --cursor or --limit.");
    }
    const count = countSkillMemory({ filters, store: { cfg } });
    if (options.json) {
      writeRuntimeJson(runtime, { count });
    } else {
      runtime.log(String(count));
    }
    return;
  }

  const limit = parsePositive(options.limit, "--limit", DEFAULT_LIMIT);
  if (limit > MAX_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_LIMIT}.`);
  }
  const cursor = options.cursor ? parsePositive(options.cursor, "--cursor") : undefined;
  const page = listSkillMemory({ filters, limit, cursor, store: { cfg } });
  if (options.json) {
    writeRuntimeJson(runtime, page);
    return;
  }
  for (const memory of page.memories) {
    runtime.log(formatMemory(memory));
  }
  if (page.nextCursor !== undefined) {
    runtime.log(`More memories: --cursor ${page.nextCursor}`);
  }
}
