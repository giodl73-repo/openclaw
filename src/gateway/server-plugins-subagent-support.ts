import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readTrajectoryAuditRun } from "../trajectory/audit-run-reader.js";
import type { TrajectoryAuditRunSummary } from "../trajectory/audit-run.js";

const PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000;

export function normalizePluginSubagentMessageLimit(limit?: number): number | undefined {
  return limit == null || !Number.isFinite(limit)
    ? undefined
    : Math.min(PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function readCompletedPluginSubagentAudit(params: {
  cfg?: OpenClawConfig;
  runId: string;
  sessionKey?: string;
  status: string;
}): TrajectoryAuditRunSummary | undefined {
  if (params.status !== "ok" || !params.cfg || !params.sessionKey) {
    return undefined;
  }
  return readTrajectoryAuditRun({
    cfg: params.cfg,
    runId: params.runId,
    sessionKey: params.sessionKey,
  });
}
