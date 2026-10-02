import { randomUUID } from "node:crypto";
import type {
  AcpPermissionHandler,
  AcpRuntimeTurnInput as AcpxRuntimeTurnInput,
} from "acpx/runtime";
import { consumeAcpTurnStream } from "openclaw/plugin-sdk/acp-runtime";
import { runAgentHarnessAdapterAttempt } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type {
  AgentHarnessAttemptParamsV2,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS } from "openclaw/plugin-sdk/approval-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { AcpRuntimeTurnInput } from "../runtime-api.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

export async function runAcpHarnessAttempt(params: {
  input: AgentHarnessAttemptParamsV2;
  runtime: CompleteAcpRuntime;
  agent: string;
  harnessId: string;
  label: string;
  command: string[];
  generationSignal: AbortSignal;
}): Promise<EmbeddedRunAttemptResult> {
  const { input, runtime } = params;
  return await runAgentHarnessAdapterAttempt({
    input,
    harnessId: params.harnessId,
    label: params.label,
    generationSignal: params.generationSignal,
    adapter: {
      async prepare({ signal, assertActive, entries, agentId, sessionKey }) {
        // Session initialization cannot guard model controls; use live turn authority below.
        const handle = await runtime.ensureSession({
          agentId,
          sessionKey: `agent:${agentId}:harness:${params.harnessId}:${input.sessionId}`,
          agent: params.agent,
          agentCommand: params.command,
          mode: "persistent",
          bridgeSession: { agentId, sessionKey, native: true },
          cwd: input.workspaceDir,
        });
        assertActive();
        const status = await runtime.getStatus({ handle });
        assertActive();
        if (status.models?.currentModelId !== input.modelId) {
          await runtime.setModel({ handle, model: input.modelId, signal, assertActive });
        }
        assertActive();
        const lastRequestId = status.lastRequestId;
        const previousAssistantIndex = lastRequestId
          ? entries.findLastIndex(
              (entry) =>
                entry.type === "message" &&
                "idempotencyKey" in entry.message &&
                entry.message.idempotencyKey === `${lastRequestId}:acp:assistant`,
            )
          : -1;
        const previousUserIndex =
          lastRequestId && previousAssistantIndex < 0
            ? entries.findLastIndex(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "user" &&
                  (entry.id === lastRequestId || lastRequestId.startsWith(`${entry.id}:acp:`)),
              )
            : -1;
        if (lastRequestId && previousAssistantIndex < 0 && previousUserIndex < 0) {
          throw new Error(
            "ACP conversation history cannot be reconciled; reset this session before continuing",
          );
        }
        return {
          // Do not replay a possibly cancelled native request whose assistant was not committed.
          replayAfterIndex:
            previousAssistantIndex >= 0 ? previousAssistantIndex : previousUserIndex,
          includeBootstrap: !lastRequestId,
          async run(host) {
            let denied = false;
            let approvalFailure: Error | undefined;
            const onPermissionRequest: AcpPermissionHandler = async (request, context) => {
              try {
                assertActive();
                const approvalSignal = AbortSignal.any([signal, context.signal]);
                const detail = JSON.stringify(request.raw.toolCall);
                // ACPX falls back from allow_once to allow_always; never widen the user's grant.
                const supportsAllowOnce = request.raw.options.some(
                  (option) => option.kind === "allow_once",
                );
                const requestResult = await input.hostCapabilities.requestApproval({
                  title: `${params.label} permission request`,
                  description: request.raw.toolCall.title ?? "Native tool action",
                  detail,
                  signal: approvalSignal,
                  severity: "warning",
                  toolName: request.inferredKind ?? "other",
                  toolCallId: request.raw.toolCall.toolCallId,
                  allowedDecisions: supportsAllowOnce ? ["allow-once", "deny"] : ["deny"],
                  timeoutMs: DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
                  transportTimeoutMs: DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000,
                });
                const result = requestResult?.id
                  ? await input.hostCapabilities.waitForApproval({
                      approvalId: requestResult.id,
                      timeoutMs: DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
                      transportTimeoutMs: DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000,
                      signal: approvalSignal,
                    })
                  : undefined;
                assertActive();
                approvalSignal.throwIfAborted();
                const allowed = supportsAllowOnce && result?.decision === "allow-once";
                denied ||= !allowed;
                return { outcome: allowed ? "allow_once" : "reject_once" };
              } catch (error) {
                if (!signal.aborted && !context.signal.aborted) {
                  approvalFailure = toErrorObject(error, "Native approval request failed");
                }
                denied = true;
                return { outcome: "cancel" };
              }
            };
            const requestId = `${host.admissionEntryId}:acp:${randomUUID()}`;
            // Prose labels keep file paths and literal user text out of slash-command dispatch.
            const turn: AcpRuntimeTurnInput &
              Pick<AcpxRuntimeTurnInput, "onPermissionRequest" | "assertActive"> = {
              handle,
              text: [
                host.developerInstructions
                  ? `Conversation instructions:\n${host.developerInstructions}`
                  : undefined,
                host.previousMessages.length
                  ? `Conversation context before this turn:\n${JSON.stringify(host.previousMessages)}`
                  : undefined,
                `Current turn:\n${host.prompt}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              mode: "prompt",
              requestId,
              signal,
              assertActive,
              onPermissionRequest,
              ...(input.images?.length
                ? {
                    attachments: input.images.map((image) => ({
                      data: image.data,
                      mediaType: image.mimeType,
                    })),
                  }
                : {}),
            };
            const outcome = await consumeAcpTurnStream({
              runtime,
              turn,
              eventGate: host.eventGate,
              onBeforePrompt: assertActive,
              onPromptStarted: host.markSubmitted,
              onOutputEvent: async (event) => {
                await host.emit(
                  event.type === "text_delta"
                    ? { type: "text", text: event.text, reasoning: event.stream === "thought" }
                    : {
                        type: "tool",
                        toolCallId: event.toolCallId,
                        name: event.title ?? event.kind ?? "tool",
                        text: event.text,
                        failed: event.status === "failed",
                      },
                );
              },
            });
            if (approvalFailure) {
              throw approvalFailure;
            }
            return {
              cancelled: outcome.terminalStatus === "cancelled",
              permissionDenied: denied,
              assistantIdempotencyKey: `${requestId}:acp:assistant`,
              async readUsage() {
                const usage = (await runtime.getStatus({ handle })).usage?.perRequest?.[requestId];
                return {
                  input: usage?.inputTokens ?? 0,
                  output: usage?.outputTokens ?? 0,
                  cacheRead: usage?.cachedReadTokens ?? 0,
                  cacheWrite: usage?.cachedWriteTokens ?? 0,
                  total: usage?.totalTokens ?? 0,
                };
              },
            };
          },
        };
      },
    },
  });
}
