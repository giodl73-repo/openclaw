import {
  ControlModelCommandError,
  type ControlModelSendInput,
} from "@openclaw/gateway-client/model";
import type {
  ChatSendIntent,
  QueueMode,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { buildChatApiAttachments } from "./attachment-api.ts";
import {
  controlModelAgentIdForRoute,
  selectedControlModelConversationForRoute,
} from "./chat-control-model.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { normalizeChatSendAck, type ChatSendAck } from "./chat-send-ack.ts";
import type { ChatState } from "./chat-state-contract.ts";

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    mentions?: readonly HumanMention[];
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
    queueMode?: QueueMode;
    intent?: ChatSendIntent;
    sessionId?: string;
    replyToId?: string;
    expectedLeafEntryId?: string | null;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, params);
  const sessionId = params.sessionId ?? (params.intent ? undefined : routing.sessionId);
  const controlUiReconnectResume = Boolean(
    !params.intent && sessionId && state.reconnectResumeSessionId === sessionId,
  );
  const attachments = buildChatApiAttachments(params.attachments);
  const routeAgentId = controlModelAgentIdForRoute(state, routing.sessionKey);
  // Mentions, typed send intents, steer, and reconnect resume carry Gateway-only
  // request fields the Control Model send contract does not express.
  // An explicit agent override only matches when it names this route's agent.
  const conversation =
    !controlUiReconnectResume &&
    params.queueMode !== "steer" &&
    !params.intent &&
    !params.mentions?.length &&
    (params.agentId === undefined || normalizeAgentId(params.agentId) === routeAgentId)
      ? selectedControlModelConversationForRoute(state, routing.sessionKey, routeAgentId)
      : null;
  let payload: unknown;
  if (conversation) {
    const input: ControlModelSendInput = {
      message: params.message,
      idempotencyKey: params.runId,
      ...(sessionId ? { sessionId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      ...(params.queueMode ? { queueMode: params.queueMode } : {}),
      ...(params.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: params.expectedLeafEntryId }
        : {}),
    };
    try {
      payload = await conversation.send(input);
    } catch (error) {
      if (!(error instanceof ControlModelCommandError)) {
        throw error;
      }
      throw new GatewayRequestError({
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    }
  } else {
    payload = await state.client!.request("chat.send", {
      sessionKey: routing.sessionKey,
      ...(isUiGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
        ? { agentId: routing.selectedAgentId }
        : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(controlUiReconnectResume ? { __controlUiReconnectResume: true } : {}),
      message: params.message,
      ...(params.mentions?.length ? { mentions: params.mentions } : {}),
      ...(params.intent ? { intent: params.intent } : {}),
      deliver: false,
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      ...(params.queueMode ? { queueMode: params.queueMode } : {}),
      ...(params.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: params.expectedLeafEntryId }
        : {}),
      idempotencyKey: params.runId,
      attachments,
    });
  }
  if (controlUiReconnectResume) {
    state.reconnectResumeSessionId = null;
  }
  return normalizeChatSendAck(payload, params.runId);
}

export function resolveDisplayedLeafEntryId(state: ChatState): string | null | undefined {
  if (state.chatLoading || isInitialChatHistoryUnavailable(state)) {
    return undefined;
  }
  if (state.chatDisplayedLeafEntryId === null) {
    return null;
  }
  const leafEntryId = state.chatDisplayedLeafEntryId?.trim();
  return leafEntryId || undefined;
}

const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function isActiveLeafChangedError(err: unknown): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = err.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { reason?: unknown }).reason === ACTIVE_LEAF_CHANGED_ERROR_REASON
  );
}

function resolveChatSendRouting(
  state: ChatState,
  params: {
    sessionKey?: string;
    agentId?: string;
  },
): { selectedAgentId?: string; sessionId?: string; sessionKey: string } {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveUiSelectedSessionAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isUiGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined &&
        selectedAgentId === resolveUiSelectedSessionAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  return {
    sessionKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
