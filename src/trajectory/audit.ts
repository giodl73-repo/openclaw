import type { AgentToolReceipt } from "../../packages/agent-core/src/types.js";
import type { TrajectoryEvent } from "./types.js";

export type ObservedToolAuditResult = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

export type TrajectoryAuditReceipt = AgentToolReceipt & {
  toolCallId: string;
  toolName: string;
};

const RECEIPT_TYPE_MAX_CHARS = 256;
const RECEIPT_SUBJECT_TYPE_MAX_CHARS = 256;
const RECEIPT_SUBJECT_ID_MAX_CHARS = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSubject(value: unknown): AgentToolReceipt["subject"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return type &&
    type.length <= RECEIPT_SUBJECT_TYPE_MAX_CHARS &&
    id &&
    id.length <= RECEIPT_SUBJECT_ID_MAX_CHARS
    ? { type, id }
    : undefined;
}

function normalizeAuditRecord(value: unknown): AgentToolReceipt | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (!type || type.length > RECEIPT_TYPE_MAX_CHARS) {
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

/** Returns whether a trajectory event references a recorded receipt of an optional exact type. */
export function isTrajectoryAuditReceipt(event: TrajectoryEvent, receiptType?: string): boolean {
  if (event.type !== "audit.receipt.recorded") {
    return false;
  }
  const eventReceiptType = typeof event.data?.type === "string" ? event.data.type.trim() : "";
  if (!eventReceiptType) {
    return false;
  }
  const expectedType = receiptType?.trim();
  return !expectedType || eventReceiptType === expectedType;
}

/**
 * Reads typed audit records from a successful, already-sanitized tool observation.
 * Session, run, model, and timestamp correlation are added by the trajectory recorder.
 */
export function collectToolAuditReceipts(event: ObservedToolAuditResult): TrajectoryAuditReceipt[] {
  if (event.isError || !isRecord(event.result) || !Array.isArray(event.result.receipts)) {
    return [];
  }
  const receipts: TrajectoryAuditReceipt[] = [];
  for (const candidate of event.result.receipts) {
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
