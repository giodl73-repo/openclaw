import {
  collectToolAuditReceipts,
  type ObservedToolAuditResult,
  type TrajectoryAuditReceipt,
} from "../../../trajectory/audit.js";

/** Collects valid receipts from an already-sanitized tool observation. */
export function collectAttemptToolAuditReceipts(params: {
  event: ObservedToolAuditResult;
}): TrajectoryAuditReceipt[] {
  return collectToolAuditReceipts(params.event);
}
