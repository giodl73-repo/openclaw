import {
  isAuditReceiptStoreEnabled,
  recordAuditReceipt,
} from "../../../audit/receipt-store.sqlite.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../../routing/session-key.js";
/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import { runAgentHarnessAttempt } from "../../harness/selection.js";
import { log } from "../logger.js";
import { collectAttemptToolAuditReceipts } from "./attempt-audit-receipts.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const onAgentToolResult = params.onAgentToolResult;
  try {
    return await runAgentHarnessAttempt({
      ...params,
      onAgentToolResult: (event) => {
        const occurredAt = Date.now();
        if (!isAuditReceiptStoreEnabled(params.config)) {
          onAgentToolResult?.(event);
          return;
        }
        for (const [receiptIndex, receipt] of collectAttemptToolAuditReceipts({
          event,
        }).entries()) {
          try {
            const recorded = recordAuditReceipt(
              {
                receipt,
                receiptIndex,
                occurredAt,
                agentId: normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID),
                sessionId: params.sessionId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                runId: params.runId,
                toolName: receipt.toolName,
                toolCallId: receipt.toolCallId,
              },
              { cfg: params.config },
            );
            params.trajectoryRecorder?.recordEvent("audit.receipt.recorded", {
              receiptId: recorded.receiptId,
              type: recorded.receiptType,
              ...(recorded.receiptVersion === undefined
                ? {}
                : { version: recorded.receiptVersion }),
              ...(recorded.subject ? { subject: recorded.subject } : {}),
              toolName: recorded.toolName,
              toolCallId: recorded.toolCallId,
            });
          } catch (error) {
            log.warn(`failed to record audit receipt: ${formatErrorMessage(error)}`);
          }
        }
        onAgentToolResult?.(event);
      },
    });
  } finally {
    try {
      await params.trajectoryRecorder?.flush();
    } catch (error) {
      log.warn(`failed to flush harness trajectory: ${formatErrorMessage(error)}`);
    }
  }
}
