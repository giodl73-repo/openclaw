import { z } from "zod";

export const SkillMemorySchema = z
  .object({
    enabled: z.boolean().optional(),
    store: z
      .object({
        type: z.literal("sqlite"),
        path: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SKILL_MEMORY_FIELD_HELP: Record<string, string> = {
  skillMemory:
    "Durable, searchable memory of completed work recorded by trusted tools. This is separate from semantic memory and vector search.",
  "skillMemory.enabled":
    "Remember new completed-work facts. Default: true. Disabling writes does not delete existing skill memory.",
  "skillMemory.store":
    "Shared Skill Memory store configuration. Version 1 supports a local SQLite database.",
  "skillMemory.store.type": 'Skill Memory store type. Version 1 supports only "sqlite".',
  "skillMemory.store.path":
    "Optional Skill Memory SQLite path. Defaults to skill-memory.sqlite in the OpenClaw shared state directory.",
};

export const SKILL_MEMORY_FIELD_LABELS: Record<string, string> = {
  skillMemory: "Skill Memory",
  "skillMemory.enabled": "Remember Completed Work",
  "skillMemory.store": "Skill Memory Store",
  "skillMemory.store.type": "Skill Memory Store Type",
  "skillMemory.store.path": "Skill Memory Database Path",
};
