import { resolveStorePath } from "../../../config/sessions/paths.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  collectToolAuditReceipts,
  type ObservedToolAuditResult,
  snapshotAuditReceiptRegarding,
  type TrajectoryAuditReceipt,
} from "../../../trajectory/audit.js";
import { log } from "../logger.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Collects valid receipts and snapshots the session's business association at result time. */
export function collectAttemptToolAuditReceipts(params: {
  agentId: string;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "config" | "sessionFile" | "sessionKey" | "sessionTarget" | "trajectorySessionFile"
  >;
  event: ObservedToolAuditResult;
}): TrajectoryAuditReceipt[] {
  const receipts = collectToolAuditReceipts(params.event);
  if (receipts.length === 0) {
    return receipts;
  }
  const sessionKey = params.attempt.sessionTarget?.sessionKey ?? params.attempt.sessionKey;
  if (!sessionKey) {
    return receipts;
  }
  try {
    const marker = parseSqliteSessionFileMarker(
      params.attempt.trajectorySessionFile ?? params.attempt.sessionFile,
    );
    const storePath =
      params.attempt.sessionTarget?.storePath ??
      marker?.storePath ??
      resolveStorePath(params.attempt.config?.session?.store, { agentId: params.agentId });
    const regarding = loadSessionEntry({
      agentId: params.agentId,
      readConsistency: "latest",
      sessionKey,
      storePath,
    })?.regarding;
    return receipts.map((receipt) => snapshotAuditReceiptRegarding(receipt, regarding));
  } catch (error) {
    log.warn(
      `failed to snapshot session regarding onto audit receipt: ${formatErrorMessage(error)}`,
    );
    return receipts;
  }
}
