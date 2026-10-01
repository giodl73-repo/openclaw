import { resolveStorePath } from "../../config/sessions/paths.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { appendSessionTranscriptMessageByIdentityStrict } from "../../plugin-sdk/session-transcript-runtime.js";
import { resolveBootstrapContextForRun } from "../bootstrap-files.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import type { AgentHarnessAdapterAttemptParams } from "./adapter-attempt.js";
import { createAgentHarnessAssistantMessage } from "./projection-messages.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

type AgentMessage = EmbeddedRunAttemptResult["messagesSnapshot"][number];

/** Host-owned ordinary-turn orchestration underneath the existing harness lifecycle. */
export async function runAgentHarnessAdapterAttempt(
  params: AgentHarnessAdapterAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const { input } = params;
  if (!input.agentId || !input.sessionKey) {
    throw new Error("Agent adapter requires an owned OpenClaw session");
  }
  const agentId = input.agentId;
  const sessionKey = input.sessionKey;
  const recorder = input.userTurnTranscriptRecorder;
  if (!recorder) {
    throw new Error("Agent adapter requires its admitted transcript recorder");
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    params.generationSignal,
    ...(input.abortSignal ? [input.abortSignal] : []),
  ]);
  const eventGate = { open: !signal.aborted };
  const stopDelivery = () => {
    eventGate.open = false;
  };
  const assertActive = () => {
    if (settled) {
      throw new Error("Agent adapter attempt is closed");
    }
    signal.throwIfAborted();
    input.hostCapabilities.assertActive();
  };
  const transcript = {
    agentId,
    sessionKey,
    sessionId: input.sessionId,
    storePath: resolveStorePath(input.config?.session?.store, { agentId }),
  };
  let text = "";
  let reasoning = "";
  let started = false;
  let settled = false;
  let timedOut = false;
  let failure: unknown;
  let cancelled = false;
  let terminalAnchor: EmbeddedRunAttemptResult["contextEngineTerminalAnchor"];
  let assistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
  let assistantIdempotencyKey: string | undefined;
  const toolMetas: EmbeddedRunAttemptResult["toolMetas"] = [];
  let messages: AgentMessage[] = [];
  const activeRun = {
    kind: "embedded" as const,
    runId: input.runId,
    toolAuthorityFingerprint: input.toolAuthorityFingerprint,
    queueMessage: async () => {
      throw new Error(`${params.label} does not support live message injection`);
    },
    isStreaming: () => started && !settled,
    isAborted: () => signal.aborted,
    isCompacting: () => false,
    cancel: () => controller.abort(),
    abort: () => controller.abort(),
    sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
  };
  let activeRegistered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  assertActive();
  try {
    setActiveEmbeddedRun(input.sessionId, activeRun, sessionKey, input.sessionFile, agentId);
    activeRegistered = true;
    input.replyOperation?.attachBackend(activeRun);
    signal.addEventListener("abort", stopDelivery, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        input.onAttemptTimeout?.(new Error(`${params.label} turn timed out`));
      } finally {
        controller.abort();
      }
    }, input.timeoutMs);
    timer.unref();
    const sessionContext = await SessionManager.openModelContextAsync(transcript, {
      cwd: input.workspaceDir,
      signal,
    });
    const entries = sessionContext.getBranch();
    messages = sessionContext.buildSessionContext().messages;
    assertActive();
    const prepared = await params.adapter.prepare({
      signal,
      assertActive,
      entries,
      agentId,
      sessionKey,
    });
    assertActive();
    await recorder.persistApproved({ expectedSessionId: input.sessionId });
    assertActive();
    const admission = recorder.getAdmissionReceipt();
    if (recorder.isBlocked() || !recorder.hasPersisted() || !admission) {
      throw new Error("Agent adapter input was not admitted to its transcript");
    }
    const previous = buildSessionContext(
      entries
        .slice(prepared.replayAfterIndex + 1)
        .filter((entry) => entry.id !== admission.entryId),
    ).messages;
    const bootstrap = prepared.includeBootstrap
      ? await resolveBootstrapContextForRun({
          workspaceDir: input.workspaceDir,
          config: input.config,
          sessionKey,
          sessionId: input.sessionId,
          agentId,
          chatType: input.chatType,
          contextMode: input.bootstrapContextMode,
          runKind: input.bootstrapContextRunKind,
        })
      : undefined;
    assertActive();
    const built = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: input.prompt,
      currentInboundContext: input.currentInboundContext,
      messages,
      developerInstructions: [
        ...(bootstrap?.contextFiles.map((file) => `${file.path}\n${file.content}`) ?? []),
        input.extraSystemPrompt,
      ]
        .filter(Boolean)
        .join("\n\n"),
      ctx: {
        runId: input.runId,
        agentId,
        sessionId: input.sessionId,
        sessionKey,
        workspaceDir: input.workspaceDir,
        config: input.config,
        trigger: input.trigger,
        modelProviderId: input.provider,
        modelId: input.modelId,
      },
      bootstrapContextRunKind: input.bootstrapContextRunKind,
    });
    assertActive();
    if (built.toolsAllow) {
      throw new Error(`${params.label} cannot enforce this prompt-hook tool restriction`);
    }
    const outcome = await prepared.run({
      admissionEntryId: admission.entryId,
      prompt: built.prompt,
      developerInstructions: built.developerInstructions,
      previousMessages: previous,
      eventGate,
      markSubmitted: () => {
        if (settled || started) {
          return;
        }
        started = true;
        recorder.markSentToProvider?.();
        input.onExecutionStarted?.();
      },
      emit: async (event) => {
        assertActive();
        if (!eventGate.open) {
          throw new Error("Agent adapter output is closed");
        }
        if (event.type === "text") {
          if (event.reasoning) {
            reasoning += event.text;
            await input.onReasoningStream?.({ text: reasoning });
          } else {
            if (!text) {
              await input.onAssistantMessageStart?.();
              assertActive();
            }
            text += event.text;
            const update = { stream: "assistant", data: { text, delta: event.text } };
            emitAgentEvent({
              runId: input.runId,
              sessionKey,
              sessionId: input.sessionId,
              ...update,
            });
            await input.onAgentEvent?.(update);
            assertActive();
            await input.onPartialReply?.({ text });
          }
        } else {
          const existing = event.toolCallId
            ? toolMetas.find((tool) => tool.toolCallId === event.toolCallId)
            : undefined;
          const metadata = {
            toolName: event.name,
            toolCallId: event.toolCallId,
            meta: event.text,
            isError: event.failed,
          };
          if (existing) {
            Object.assign(existing, metadata);
          } else {
            toolMetas.push(metadata);
          }
          await input.onToolResult?.({ text: event.text });
        }
      },
    });
    stopDelivery();
    cancelled = outcome.cancelled;
    if (!text.trim() && outcome.permissionDenied) {
      text = `${params.label} could not complete this turn because permission was not granted.`;
    } else if (!text.trim() && toolMetas.some((tool) => tool.isError)) {
      text = `${params.label} reported a failed tool operation and did not return an answer.`;
    }
    const usage = await outcome.readUsage();
    assistant = createAgentHarnessAssistantMessage(
      { provider: input.provider, modelId: input.modelId, api: input.model.api },
      text,
      {
        aborted: cancelled,
        tokenUsage: usage,
        content: [
          ...(reasoning ? [{ type: "thinking" as const, thinking: reasoning }] : []),
          ...(text ? [{ type: "text" as const, text }] : []),
        ],
      },
    );
    // Cancellation may leave a useful partial response; live host authority still owns its commit.
    const written = await appendSessionTranscriptMessageByIdentityStrict({
      ...transcript,
      config: input.config,
      runId: input.runId,
      updateMode: "inline",
      message: { ...assistant, idempotencyKey: outcome.assistantIdempotencyKey },
      prepareMessageAfterIdempotencyCheck: (message) => {
        input.hostCapabilities.assertActive();
        return message;
      },
    });
    if (written.kind !== "result") {
      throw new Error("Agent adapter assistant transcript was not committed");
    }
    assistant = written.result.message;
    assistantIdempotencyKey = outcome.assistantIdempotencyKey;
    terminalAnchor = written.result.anchor;
    messages = (
      await SessionManager.openModelContextAsync(transcript, {
        cwd: input.workspaceDir,
        through: written.result.anchor,
      })
    ).buildSessionContext().messages;
  } catch (error) {
    failure = error;
  } finally {
    settled = true;
    stopDelivery();
    clearTimeout(timer);
    signal.removeEventListener("abort", stopDelivery);
    input.replyOperation?.detachBackend(activeRun);
    if (activeRegistered) {
      clearActiveEmbeddedRun(input.sessionId, activeRun, sessionKey, input.sessionFile);
    }
  }
  return {
    terminal: timedOut
      ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
      : signal.aborted || cancelled
        ? { kind: "aborted", source: "external" }
        : failure
          ? { kind: "failed", source: "prompt", error: failure }
          : { kind: "ok" },
    sessionIdUsed: input.sessionId,
    sessionFileUsed: input.sessionFile,
    agentHarnessId: params.harnessId,
    runtimeModelSelection: { provider: input.provider, model: input.modelId },
    messagesSnapshot: messages,
    assistantTexts: text ? [text] : [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    ...(assistantIdempotencyKey
      ? {
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: assistantIdempotencyKey,
          contextEngineTerminalAnchor: terminalAnchor,
        }
      : {}),
    toolMetas,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: toolMetas.length > 0, replaySafe: !started },
    itemLifecycle: {
      startedCount: toolMetas.length,
      completedCount: failure ? 0 : toolMetas.length,
      activeCount: 0,
    },
  };
}
