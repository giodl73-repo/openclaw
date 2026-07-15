import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../gateway/session-store-key.js";
import { summarizeTrajectoryAuditRuns, type TrajectoryAuditRunSummary } from "./audit-run.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "./runtime-store.sqlite.js";

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
  return summarizeTrajectoryAuditRuns(events).find((summary) => summary.runId === params.runId);
}
