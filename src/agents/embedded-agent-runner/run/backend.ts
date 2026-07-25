import { formatErrorMessage } from "../../../infra/errors.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../../routing/session-key.js";
/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import {
  isSkillMemoryStoreEnabled,
  recordSkillMemoryBatch,
} from "../../../skill-memory/store.sqlite.js";
import { collectToolSkillMemory } from "../../../trajectory/skill-memory.js";
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
      const toolCallId = event.toolCallId;
      // Durable memory needs exact call provenance; harness events without a
      // stable call id remain observable but are not admitted to the store.
      if (isSkillMemoryStoreEnabled(params.config) && toolCallId) {
        const collected = collectToolSkillMemory({ ...event, toolCallId });
        if (collected.omittedCandidateCount > 0) {
          log.warn(
            `ignored ${collected.omittedCandidateCount} Skill Memory candidates above the per-tool-result limit`,
          );
        }
        let recordedMemories: ReturnType<typeof recordSkillMemoryBatch> = [];
        try {
          const occurredAt = Date.now();
          recordedMemories = recordSkillMemoryBatch(
            collected.memories.map((memory, memoryIndex) =>
              Object.assign(
                {
                  memory,
                  memoryIndex,
                  occurredAt,
                  agentId: normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID),
                  sessionId: params.sessionId,
                  runId: params.runId,
                  toolName: memory.toolName,
                  toolCallId: memory.toolCallId,
                },
                params.sessionKey ? { sessionKey: params.sessionKey } : {},
              ),
            ),
            { cfg: params.config },
          );
        } catch (error) {
          log.warn(`failed to remember Skill Memory batch: ${formatErrorMessage(error)}`);
        }
        for (const recorded of recordedMemories) {
          try {
            params.trajectoryRecorder?.recordEvent("skill.memory.remembered", {
              memoryId: recorded.memoryId,
              type: recorded.type,
              ...(recorded.subject ? { subject: recorded.subject } : {}),
              toolName: recorded.toolName,
              toolCallId: recorded.toolCallId,
            });
          } catch (error) {
            log.warn(`failed to record Skill Memory reference: ${formatErrorMessage(error)}`);
          }
        }
      }
      onAgentToolResult?.(event);
    },
  });
}
