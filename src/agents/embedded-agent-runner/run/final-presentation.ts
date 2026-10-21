import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isHostNoticePayload,
  isReplyPayloadTerminalContent,
} from "../../../auto-reply/reply-payload.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { isEmbeddedRunTerminalTimeout, type EmbeddedRunTerminalState } from "./terminal-outcome.js";
import type { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Decorates the selected ordinary final after the terminal owner has resolved retries and errors. */
export function attachEmbeddedFinalPresentation(
  input: {
    attempt: EmbeddedRunAttemptResult;
    runParams: Pick<RunEmbeddedAgentInternalParams, "sourceReplyDeliveryMode">;
    prepared: Pick<
      ReturnType<typeof prepareEmbeddedRunTerminal>,
      "replyDeliveryState" | "sourceReplyDeliveryState"
    >;
    terminalState: EmbeddedRunTerminalState;
  },
  result: EmbeddedAgentRunResult,
): EmbeddedAgentRunResult {
  const finalPresentation = input.attempt.finalPresentation;
  // Consume the terminal owner's outcome; presentation is never completion evidence.
  if (
    !finalPresentation ||
    result.meta.error ||
    result.meta.aborted ||
    isEmbeddedRunTerminalTimeout(input.terminalState.outcome) ||
    input.attempt.didSendDeterministicApprovalPrompt ||
    result.meta.intentionalTerminalCompletion ||
    result.meta.terminalReply?.disposition !== "visible" ||
    result.meta.stopReason !== "stop"
  ) {
    return result;
  }
  const payloads = result.payloads;
  // Select first, then check eligibility: a structured final must not retarget earlier prose.
  const index = payloads?.findLastIndex((payload) => {
    const metadata = getReplyPayloadMetadata(payload);
    return (
      isReplyPayloadTerminalContent(payload) &&
      !isHostNoticePayload(payload) &&
      Boolean(payload.text?.trim()) &&
      !payload.btw &&
      !metadata?.precedingInputAnswer &&
      !metadata?.sourceReplyTranscriptMirror &&
      !metadata?.deliverDespiteSourceReplySuppression
    );
  });
  if (payloads && index !== undefined && index >= 0) {
    const payload = payloads[index];
    if (payload && !payload.presentation && !payload.interactive && !payload.channelData) {
      return {
        ...result,
        payloads: payloads.with(
          index,
          copyReplyPayloadMetadata(payload, { ...payload, presentation: finalPresentation }),
        ),
      };
    }
  } else if (
    !payloads?.length &&
    input.prepared.replyDeliveryState === "delivered" &&
    input.prepared.sourceReplyDeliveryState !== "pending" &&
    input.runParams.sourceReplyDeliveryMode !== "message_tool_only" &&
    !input.attempt.heartbeatToolResponse &&
    !hasCommittedSourceReplyDeliveryEvidence(input.attempt) &&
    !hasMessagingToolDeliveryEvidence(input.attempt)
  ) {
    // Ordinary prose already streamed. Do not replay it or revive a suppressed tool reply.
    return { ...result, payloads: [{ presentation: finalPresentation }] };
  }
  return result;
}
