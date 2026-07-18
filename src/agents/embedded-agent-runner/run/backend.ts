/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import {
  isAuditReceiptStoreEnabled,
  recordAuditReceiptBatch,
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
        const collected = collectToolAuditReceipts(event);
        if (collected.omittedCandidateCount > 0) {
          log.warn(
            `ignored ${collected.omittedCandidateCount} audit receipt candidates above the per-tool-result limit`,
          );
        }
        let recordedReceipts: ReturnType<typeof recordAuditReceiptBatch> = [];
        try {
          const occurredAt = Date.now();
          recordedReceipts = recordAuditReceiptBatch(
            collected.receipts.map((receipt, receiptIndex) =>
              Object.assign(
                {
                  receipt,
                  receiptIndex,
                  occurredAt,
                  agentId: normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID),
                  sessionId: params.sessionId,
                  runId: params.runId,
                  toolName: receipt.toolName,
                  toolCallId: receipt.toolCallId,
                },
                params.sessionKey ? { sessionKey: params.sessionKey } : {},
              ),
            ),
            { cfg: params.config },
          );
        } catch (error) {
          log.warn(`failed to record audit receipt batch: ${formatErrorMessage(error)}`);
        }
        for (const recorded of recordedReceipts) {
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
