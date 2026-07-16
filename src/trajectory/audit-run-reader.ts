import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../gateway/session-store-key.js";
import { summarizeTrajectoryAuditRuns, type TrajectoryAuditRunSummary } from "./audit-run.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "./runtime-store.sqlite.js";

function toAuditRunReceipt(receipt: RecordedAuditReceipt): Record<string, unknown> {
  return {
    receiptId: receipt.receiptId,
    type: receipt.receiptType,
    ...(receipt.receiptVersion === undefined ? {} : { version: receipt.receiptVersion }),
    ...(receipt.subject ? { subject: receipt.subject } : {}),
    ...(receipt.data ? { data: receipt.data } : {}),
    ...(receipt.invocationId ? { invocationId: receipt.invocationId } : {}),
    ...(receipt.skillName ? { skillName: receipt.skillName } : {}),
    ...(receipt.skillDigest ? { skillDigest: receipt.skillDigest } : {}),
    toolName: receipt.toolName,
    toolCallId: receipt.toolCallId,
  };
}

/** Reads one run's persisted audit projection without exposing trajectory storage to plugins. */
export function readTrajectoryAuditRun(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId: string;
  sessionKey: string;
}): TrajectoryAuditRunSummary | undefined {
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId,
    env: params.env,
  });
  const entry = loadSessionEntry({
    agentId,
    env: params.env,
    readConsistency: "latest",
    sessionKey: canonicalKey,
    storePath,
  });
  if (!entry?.sessionId) {
    return undefined;
  }
  const events = loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId,
    env: params.env,
    sessionId: entry.sessionId,
    storePath,
  }).map((row) => row.event);
  const summary = summarizeTrajectoryAuditRuns(events).find(
    (candidate) => candidate.runId === params.runId,
  );
  if (!summary) {
    return undefined;
  }
  const filters = { runId: params.runId, sessionKey: canonicalKey };
  const store = { cfg: params.cfg, env: params.env };
  const receiptCount = countAuditReceipts({ filters, store });
  if (receiptCount === 0) {
    return summary;
  }
  const receipts = listAuditReceipts({ filters, limit: receiptCount, store }).toReversed();
  return { ...summary, receipts: receipts.map(toAuditRunReceipt) };
}
import {
  countAuditReceipts,
  listAuditReceipts,
  type RecordedAuditReceipt,
} from "../audit/receipt-store.sqlite.js";
