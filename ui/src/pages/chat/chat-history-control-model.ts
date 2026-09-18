// Control Model adoption for the authoritative Chat transcript read. The
// Gateway still owns the raw chat.history fallback whenever the model or its
// conversation cannot answer.
import type {
  ControlModel,
  ControlModelConversation,
  ControlModelConversationSnapshot,
} from "@openclaw/gateway-client/model";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { controlModelAgentIdForRoute } from "./chat-control-model.ts";
import { CHAT_HISTORY_STARTUP_RETRY_TIMEOUT_MS } from "./chat-history-request.ts";
import {
  isRetryableStartupUnavailable,
  isUnknownGatewayMethodError,
  resolveStartupRetryDelayMs,
  sleep,
} from "./chat-history-retry.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import type { ChatState } from "./chat-state-contract.ts";

export async function ensureChatControlModel(state: ChatState): Promise<ControlModel | undefined> {
  if (state.controlModel) {
    return state.controlModel;
  }
  if (!state.loadControlModel) {
    return undefined;
  }
  let model: ControlModel;
  try {
    model = await state.loadControlModel();
  } catch (error) {
    console.error("[chat] Control Model load failed; using Gateway fallback:", error);
    return undefined;
  }
  if (!state.controlModel) {
    state.controlModel = model;
    state.requestUpdate?.();
  }
  return state.controlModel;
}

export function releaseChatControlModelConversation(state: ChatState): void {
  const model = state.controlModel;
  const key = state.controlModelConversationSessionKey;
  if (!model || !key) {
    return;
  }
  const agentId = state.controlModelConversationAgentId;
  state.controlModelConversation = undefined;
  state.controlModelConversationSessionKey = null;
  state.controlModelConversationAgentId = null;
  void model.releaseConversation(key, agentId ? { agentId } : {}).catch(() => undefined);
}

function controlModelConversationForState(state: ChatState): ControlModelConversation | null {
  const model = state.controlModel;
  if (!model || !state.sessionKey.trim()) {
    return null;
  }
  const agentId = controlModelAgentIdForRoute(state, state.sessionKey);
  if (
    state.controlModelConversation &&
    state.controlModelConversationSessionKey === state.sessionKey &&
    (state.controlModelConversationAgentId ?? null) === (agentId ?? null)
  ) {
    // Reacquire from the owner: an evicted or recovered route hands back a live
    // conversation, and the cached handle alone can be a retired instance.
    const current = model.conversation(state.sessionKey, agentId ? { agentId } : {});
    state.controlModelConversation = current;
    return current;
  }
  releaseChatControlModelConversation(state);
  const conversation = model.conversation(state.sessionKey, agentId ? { agentId } : {});
  state.controlModelConversation = conversation;
  state.controlModelConversationSessionKey = state.sessionKey;
  state.controlModelConversationAgentId = agentId ?? null;
  return conversation;
}

function controlModelRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function controlModelString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function controlModelDefaults(value: unknown): GatewaySessionsDefaults | undefined {
  const source = controlModelRecord(value);
  if (!source) {
    return undefined;
  }
  const modelProvider =
    typeof source.modelProvider === "string" || source.modelProvider === null
      ? source.modelProvider
      : null;
  const model = typeof source.model === "string" || source.model === null ? source.model : null;
  const contextTokens =
    typeof source.contextTokens === "number" && Number.isFinite(source.contextTokens)
      ? source.contextTokens
      : null;
  const thinkingLevels = Array.isArray(source.thinkingLevels)
    ? source.thinkingLevels
        .map((entry) => controlModelRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .flatMap((entry) => {
          const id = controlModelString(entry.id);
          const label = controlModelString(entry.label);
          return id && label ? [{ id, label }] : [];
        })
    : undefined;
  const thinkingOptions = Array.isArray(source.thinkingOptions)
    ? source.thinkingOptions.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    modelProvider,
    model,
    contextTokens,
    ...(controlModelRecord(source.agentRuntime)
      ? { agentRuntime: source.agentRuntime as GatewaySessionsDefaults["agentRuntime"] }
      : {}),
    ...(thinkingLevels ? { thinkingLevels } : {}),
    ...(thinkingOptions ? { thinkingOptions } : {}),
    ...(controlModelString(source.thinkingDefault)
      ? { thinkingDefault: controlModelString(source.thinkingDefault) }
      : {}),
  };
}

function controlModelSessionInfo(value: unknown): GatewaySessionRow | undefined {
  const source = controlModelRecord(value);
  if (!source || !controlModelString(source.key) || typeof source.kind !== "string") {
    return undefined;
  }
  return source as GatewaySessionRow;
}

function controlModelChatMetadata(value: unknown): ChatMetadataResult | undefined {
  const source = controlModelRecord(value);
  if (
    !source ||
    !Array.isArray(source.commands) ||
    !source.commands.every((entry) => controlModelRecord(entry) !== null) ||
    (source.models !== undefined &&
      (!Array.isArray(source.models) ||
        !source.models.every((entry) => controlModelRecord(entry) !== null)))
  ) {
    return undefined;
  }
  return source as ChatMetadataResult;
}

type ChatHistoryInFlightRun = NonNullable<ChatHistoryResult["inFlightRun"]>;

function controlModelInFlightRun(value: unknown): ChatHistoryInFlightRun | undefined {
  const source = controlModelRecord(value);
  const runId = controlModelString(source?.runId);
  if (!source || !runId) {
    return undefined;
  }
  const events = Array.isArray(source.events)
    ? source.events
        .map((entry) => controlModelRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .flatMap((entry) => {
          const eventRunId = controlModelString(entry.runId);
          const stream = controlModelString(entry.stream);
          const data = controlModelRecord(entry.data);
          return eventRunId &&
            stream &&
            typeof entry.seq === "number" &&
            Number.isFinite(entry.seq) &&
            typeof entry.ts === "number" &&
            Number.isFinite(entry.ts) &&
            data
            ? [
                {
                  runId: eventRunId,
                  stream,
                  seq: entry.seq,
                  ts: entry.ts,
                  ...(controlModelString(entry.sessionKey)
                    ? { sessionKey: controlModelString(entry.sessionKey) }
                    : {}),
                  ...(controlModelString(entry.agentId)
                    ? { agentId: controlModelString(entry.agentId) }
                    : {}),
                  data,
                },
              ]
            : [];
        })
    : undefined;
  const plan = controlModelRecord(source.plan);
  const planSteps = Array.isArray(plan?.steps)
    ? plan.steps.flatMap((step) => {
        const entry = controlModelRecord(step);
        const name = controlModelString(entry?.step);
        const status = controlModelString(entry?.status);
        return typeof step === "string"
          ? [{ step, status: "pending" }]
          : name && status
            ? [{ step: name, status }]
            : [];
      })
    : undefined;
  return {
    runId,
    ...(typeof source.text === "string" ? { text: source.text } : {}),
    ...(typeof source.startedAt === "number" && Number.isFinite(source.startedAt)
      ? { startedAt: source.startedAt }
      : {}),
    ...(typeof source.sessionAbortable === "boolean"
      ? { sessionAbortable: source.sessionAbortable }
      : {}),
    ...(events ? { events } : {}),
    ...(planSteps
      ? {
          plan: {
            steps: planSteps,
            ...(typeof plan?.explanation === "string" ? { explanation: plan.explanation } : {}),
          },
        }
      : {}),
  };
}

function controlModelHistoryResult(
  state: ChatState,
  snapshot: ControlModelConversationSnapshot,
): ChatHistoryResult {
  const metadata = snapshot.metadata;
  const activeRun = snapshot.activeRun;
  const activeRunText = activeRun?.message !== undefined ? extractText(activeRun.message) : null;
  const inFlightRun =
    controlModelInFlightRun(metadata?.inFlightRun) ??
    (activeRun
      ? {
          runId: activeRun.runId,
          ...(activeRunText !== null ? { text: activeRunText } : {}),
        }
      : undefined);
  const sessionResult = state.sessions?.state?.result ?? null;
  const selectedRow = sessionResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, state.sessionKey),
  );
  return {
    messages: snapshot.messages.map((message) => message.raw),
    offset: snapshot.history.window === "older" ? (snapshot.history.nextOffset ?? 0) : 0,
    ...(snapshot.history.nextOffset !== null ? { nextOffset: snapshot.history.nextOffset } : {}),
    hasMore: snapshot.history.hasMore,
    ...(snapshot.history.totalMessages !== null
      ? { totalMessages: snapshot.history.totalMessages }
      : {}),
    completeSnapshot: snapshot.history.completeSnapshot,
    ...(typeof metadata?.sessionId === "string" ? { sessionId: metadata.sessionId } : {}),
    ...(typeof metadata?.thinkingLevel === "string"
      ? { thinkingLevel: metadata.thinkingLevel }
      : {}),
    ...(typeof metadata?.verboseLevel === "string" ? { verboseLevel: metadata.verboseLevel } : {}),
    defaults: controlModelDefaults(metadata?.defaults) ?? sessionResult?.defaults,
    sessionInfo: controlModelSessionInfo(metadata?.sessionInfo) ?? selectedRow,
    metadata: controlModelChatMetadata(metadata?.metadata),
    ...(inFlightRun ? { inFlightRun } : {}),
  };
}

/** Authoritative Control Model transcript read for one explicit history load. */
export async function loadControlModelChatHistory(
  state: ChatState,
  opts: { startup?: boolean } = {},
): Promise<ChatHistoryResult> {
  const conversation = controlModelConversationForState(state);
  if (!conversation) {
    throw new Error("Control Model conversation is unavailable");
  }
  const startup =
    opts.startup === true && isGatewayMethodAdvertised(state, "chat.startup") !== false;
  let method: "chat.history" | "chat.startup" = startup ? "chat.startup" : "chat.history";
  const retryDeadlineMs = Date.now() + CHAT_HISTORY_STARTUP_RETRY_TIMEOUT_MS;
  // Every explicit load refreshes; the conversation's own in-flight ownership
  // coalesces concurrent callers.
  for (;;) {
    try {
      await conversation.refreshHistory(undefined, method);
      break;
    } catch (error) {
      if (
        !state.connected ||
        state.controlModelConversation !== conversation ||
        state.sessionKey !== conversation.getSnapshot().sessionKey
      ) {
        throw error;
      }
      if (method === "chat.startup" && isUnknownGatewayMethodError(error, method)) {
        method = "chat.history";
        continue;
      }
      if (Date.now() < retryDeadlineMs && isRetryableStartupUnavailable(error, method)) {
        await sleep(resolveStartupRetryDelayMs(error));
        continue;
      }
      throw error;
    }
  }
  const snapshot = conversation.getSnapshot();
  if (snapshot.history.status === "error") {
    throw new Error(snapshot.history.error?.message ?? "Control Model history refresh failed");
  }
  return controlModelHistoryResult(state, snapshot);
}
