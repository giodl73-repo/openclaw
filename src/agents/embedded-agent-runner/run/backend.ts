/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import {
  isAuditReceiptStoreEnabled,
  recordAuditReceipt,
} from "../../../audit/receipt-store.sqlite.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../../routing/session-key.js";
import { collectToolAuditReceipts } from "../../../trajectory/audit.js";
import { runAgentHarnessAttempt } from "../../harness/selection.js";
import { log } from "../logger.js";
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
      if (isAuditReceiptStoreEnabled(params.config)) {
        for (const [receiptIndex, receipt] of collectToolAuditReceipts(event).entries()) {
          let recorded;
          try {
            recorded = recordAuditReceipt(
              {
                receipt,
                receiptIndex,
                occurredAt: Date.now(),
                agentId: normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID),
                sessionId: params.sessionId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                runId: params.runId,
                toolName: receipt.toolName,
                toolCallId: receipt.toolCallId,
              },
              { cfg: params.config },
            );
          } catch (error) {
            log.warn(`failed to record audit receipt: ${formatErrorMessage(error)}`);
            continue;
          }
          try {
            params.trajectoryRecorder?.recordEvent("audit.receipt.recorded", {
              receiptId: recorded.receiptId,
              type: recorded.type,
              ...(recorded.subject ? { subject: recorded.subject } : {}),
              toolName: recorded.toolName,
              toolCallId: recorded.toolCallId,
            });
          } catch (error) {
            log.warn(`failed to record audit receipt reference: ${formatErrorMessage(error)}`);
          }
        }
      }
      onAgentToolResult?.(event);
    },
  });
}
