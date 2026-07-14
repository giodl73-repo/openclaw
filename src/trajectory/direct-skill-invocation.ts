import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
// Direct skill dispatch records into the same bounded trajectory as model-backed runs.
import type { SessionRegarding } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExplicitSkillInvocation } from "../skills/types.js";
import { collectToolAuditReceipts, snapshotAuditReceiptRegarding } from "./audit.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

export type DirectSkillInvocationStatus = "blocked" | "error" | "success";

export function createDirectSkillInvocationAudit(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  invocation: ExplicitSkillInvocation;
  regarding?: SessionRegarding;
  runId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  toolCallId: string;
  toolName: string;
}) {
  const recorder = createTrajectoryRuntimeRecorder({
    cfg: params.config,
    env: params.env,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: formatSqliteSessionFileMarker({
      agentId: params.agentId,
      sessionId: params.sessionId,
      storePath: params.storePath,
    }),
  });
  if (!recorder) {
    return null;
  }
  const invocationData = {
    ...params.invocation,
    activation: "command",
    caller: "inbound",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
  };
  recorder.recordEvent("skill.invocation.started", invocationData);

  return {
    recordUse(): void {
      recorder.recordEvent("skill.used", {
        skillName: params.invocation.skillName,
        ...(params.invocation.skillSource ? { skillSource: params.invocation.skillSource } : {}),
        activation: "command",
        toolName: params.toolName,
        toolCallId: params.toolCallId,
      });
    },
    recordResult(result: unknown, isError: boolean): void {
      for (const receipt of collectToolAuditReceipts({
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        result,
        isError,
      })) {
        recorder.recordEvent("audit.receipt", {
          ...snapshotAuditReceiptRegarding(receipt, params.regarding),
        });
      }
    },
    async complete(status: DirectSkillInvocationStatus): Promise<void> {
      recorder.recordEvent("skill.invocation.completed", {
        ...invocationData,
        status,
      });
      await recorder.flush();
    },
  };
}
