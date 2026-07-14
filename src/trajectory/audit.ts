import type { AgentToolAuditRecord } from "../../packages/agent-core/src/types.js";

export type ObservedToolAuditResult = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

export type TrajectoryAuditReceipt = AgentToolAuditRecord & {
  toolCallId: string;
  toolName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSubject(value: unknown): AgentToolAuditRecord["subject"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return type && id ? { type, id } : undefined;
}

function normalizeAuditRecord(value: unknown): AgentToolAuditRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (!type) {
    return undefined;
  }
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : undefined;
  const subject = normalizeSubject(value.subject);
  const data = isRecord(value.data) ? value.data : undefined;
  return {
    type,
    ...(version === undefined ? {} : { version }),
    ...(subject ? { subject } : {}),
    ...(data ? { data } : {}),
  };
}

/**
 * Reads typed audit records from a successful, already-sanitized tool observation.
 * Session, run, model, and timestamp correlation are added by the trajectory recorder.
 */
export function collectToolAuditReceipts(event: ObservedToolAuditResult): TrajectoryAuditReceipt[] {
  if (event.isError || !isRecord(event.result) || !Array.isArray(event.result.audit)) {
    return [];
  }
  const receipts: TrajectoryAuditReceipt[] = [];
  for (const candidate of event.result.audit) {
    const record = normalizeAuditRecord(candidate);
    if (!record) {
      continue;
    }
    receipts.push({
      ...record,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  return receipts;
}
