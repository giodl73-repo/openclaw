import type { ControlModelConversation } from "@openclaw/gateway-client/model";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

/**
 * Route-fenced read of the conversation owned by `chat-history-control-model.ts`.
 * Command callers never create or replace it; a stale route falls back to Gateway.
 */
export type ChatControlModelConversationState = {
  controlModelConversation?: ControlModelConversation;
  controlModelConversationSessionKey?: string | null;
  controlModelConversationAgentId?: string | null;
};

/**
 * Single owner of the agent identity recorded for a route: only globally scoped
 * keys carry one, so a derived agent id cannot fence a direct session.
 */
export function controlModelAgentIdForRoute(
  state: Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello">,
  sessionKey: string,
): string | undefined {
  return isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state, sessionKey)
    : undefined;
}

export function selectedControlModelConversationForRoute(
  state: ChatControlModelConversationState,
  sessionKey: string,
  agentId?: string,
): ControlModelConversation | null {
  const conversation = state.controlModelConversation;
  if (
    !conversation ||
    // Bounds eviction and model disposal retire a handle the pane still caches;
    // commands fall back to the Gateway instead of addressing a dead instance.
    conversation.isDisposed ||
    state.controlModelConversationSessionKey !== sessionKey ||
    (state.controlModelConversationAgentId ?? null) !== (agentId ?? null)
  ) {
    return null;
  }
  return conversation;
}
