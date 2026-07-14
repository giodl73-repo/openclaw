import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { matchesTrajectoryAuditReceipt, type TrajectoryAuditReceiptFilter } from "./audit.js";
import type { TrajectoryEvent } from "./types.js";

const USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoningTokens",
  "total",
] as const;

type AuditRunUsageField = (typeof USAGE_FIELDS)[number];

export type TrajectoryAuditRunSummary = {
  auditSchema: "openclaw-audit-run";
  schemaVersion: 1;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  firstEventAt: string;
  lastEventAt: string;
  status?: string;
  models: Array<{ provider?: string; modelId?: string }>;
  usage?: Partial<Record<AuditRunUsageField, number>>;
  skillInvocations: Array<{
    invocationId: string;
    parentInvocationId?: string;
    parentRunId?: string;
    commandName?: string;
    skillName?: string;
    skillSource?: string;
    skillDigest?: string;
    executionHints?: Record<string, unknown>;
    status?: string;
  }>;
  skills: Array<{
    skillName: string;
    skillSource?: string;
    activation?: string;
    toolName?: string;
    toolCallId?: string;
  }>;
  receipts: Array<Record<string, unknown>>;
};

function readSkillInvocations(
  events: TrajectoryEvent[],
): TrajectoryAuditRunSummary["skillInvocations"] {
  const invocations = new Map<string, TrajectoryAuditRunSummary["skillInvocations"][number]>();
  for (const event of events) {
    if (event.type !== "skill.invocation.started" && event.type !== "skill.invocation.completed") {
      continue;
    }
    const invocationId = toOptionalString(event.data?.invocationId);
    if (!invocationId) {
      continue;
    }
    const current = invocations.get(invocationId) ?? { invocationId };
    const parentInvocationId = toOptionalString(event.data?.parentInvocationId);
    const parentRunId = toOptionalString(event.data?.parentRunId);
    const commandName = toOptionalString(event.data?.commandName);
    const skillName = toOptionalString(event.data?.skillName);
    const skillSource = toOptionalString(event.data?.skillSource);
    const skillDigest = toOptionalString(event.data?.skillDigest);
    const executionHints = isRecord(event.data?.executionHints)
      ? event.data.executionHints
      : undefined;
    const status = toOptionalString(event.data?.status);
    invocations.set(invocationId, {
      ...current,
      ...(parentInvocationId ? { parentInvocationId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(commandName ? { commandName } : {}),
      ...(skillName ? { skillName } : {}),
      ...(skillSource ? { skillSource } : {}),
      ...(skillDigest ? { skillDigest } : {}),
      ...(executionHints ? { executionHints } : {}),
      ...(status ? { status } : {}),
    });
  }
  return [...invocations.values()];
}

type AuditRunAccumulator = {
  events: TrajectoryEvent[];
  first: TrajectoryEvent;
  last: TrajectoryEvent;
};

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readUsage(events: TrajectoryEvent[]): TrajectoryAuditRunSummary["usage"] {
  const totals: Partial<Record<AuditRunUsageField, number>> = {};
  for (const event of events) {
    if (event.type !== "model.completed" || !isRecord(event.data?.usage)) {
      continue;
    }
    for (const field of USAGE_FIELDS) {
      const value = event.data.usage[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        totals[field] = (totals[field] ?? 0) + value;
      }
    }
  }
  return Object.keys(totals).length > 0 ? totals : undefined;
}

function readModels(events: TrajectoryEvent[]): TrajectoryAuditRunSummary["models"] {
  const models: TrajectoryAuditRunSummary["models"] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "model.completed") {
      continue;
    }
    const provider = toOptionalString(event.provider);
    const modelId = toOptionalString(event.modelId);
    if (!provider && !modelId) {
      continue;
    }
    const key = `${provider ?? ""}\0${modelId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      models.push({ ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}) });
    }
  }
  return models;
}

function readSkills(events: TrajectoryEvent[]): TrajectoryAuditRunSummary["skills"] {
  return events.flatMap((event) => {
    if (event.type !== "skill.used") {
      return [];
    }
    const skillName = toOptionalString(event.data?.skillName);
    if (!skillName) {
      return [];
    }
    const skillSource = toOptionalString(event.data?.skillSource);
    const activation = toOptionalString(event.data?.activation);
    const toolName = toOptionalString(event.data?.toolName);
    const toolCallId = toOptionalString(event.data?.toolCallId);
    return [
      {
        skillName,
        ...(skillSource ? { skillSource } : {}),
        ...(activation ? { activation } : {}),
        ...(toolName ? { toolName } : {}),
        ...(toolCallId ? { toolCallId } : {}),
      },
    ];
  });
}

function readStatus(events: TrajectoryEvent[]): string | undefined {
  return events.reduce<string | undefined>((status, event) => {
    return event.type === "session.ended"
      ? (toOptionalString(event.data?.status) ?? status)
      : status;
  }, undefined);
}

/** Projects existing trajectory facts into one read-only summary per run. */
export function summarizeTrajectoryAuditRuns(
  events: TrajectoryEvent[],
  receiptFilter?: TrajectoryAuditReceiptFilter,
): TrajectoryAuditRunSummary[] {
  const runs = new Map<string, AuditRunAccumulator>();
  for (const event of events) {
    const runId = event.runId?.trim();
    if (!runId) {
      continue;
    }
    const current = runs.get(runId);
    if (current) {
      current.events.push(event);
      current.last = event;
    } else {
      runs.set(runId, { events: [event], first: event, last: event });
    }
  }

  return [...runs.entries()].flatMap(([runId, run]) => {
    const receiptEvents = run.events.filter((event) =>
      matchesTrajectoryAuditReceipt(event, receiptFilter),
    );
    if (receiptFilter && receiptEvents.length === 0) {
      return [];
    }
    const skills = readSkills(run.events);
    const skillInvocations = readSkillInvocations(run.events);
    const usage = readUsage(run.events);
    const hasModelCompletion = run.events.some((event) => event.type === "model.completed");
    if (
      receiptEvents.length === 0 &&
      skills.length === 0 &&
      skillInvocations.length === 0 &&
      !hasModelCompletion
    ) {
      return [];
    }
    const sessionKey = toOptionalString(run.first.sessionKey);
    const status = readStatus(run.events);
    return [
      {
        auditSchema: "openclaw-audit-run" as const,
        schemaVersion: 1 as const,
        sessionId: run.first.sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        runId,
        firstEventAt: run.first.ts,
        lastEventAt: run.last.ts,
        ...(status ? { status } : {}),
        models: readModels(run.events),
        ...(usage ? { usage } : {}),
        skillInvocations,
        skills,
        receipts: receiptEvents.flatMap((event) => (event.data ? [event.data] : [])),
      },
    ];
  });
}
