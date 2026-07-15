/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import { runAgentHarnessAttempt } from "../../harness/selection.js";
import { collectAttemptToolAuditReceipts } from "./attempt-audit-receipts.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const onAgentToolResult = params.onAgentToolResult;
  return runAgentHarnessAttempt({
    ...params,
    onAgentToolResult: (event) => {
      for (const receipt of collectAttemptToolAuditReceipts({
        agentId: params.agentId,
        attempt: params,
        event,
      })) {
        params.trajectoryRecorder?.recordEvent("audit.receipt", { ...receipt });
      }
      onAgentToolResult?.(event);
    },
  });
}
