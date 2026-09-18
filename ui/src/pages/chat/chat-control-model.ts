import type { ControlModelConversation } from "@openclaw/gateway-client/model";

/**
 * Route-fenced read of the conversation owned by `chat-history-control-model.ts`.
 * Command callers never create or replace it; a stale route falls back to Gateway.
 */
export type ChatControlModelConversationState = {
  controlModelConversation?: ControlModelConversation;
  controlModelConversationSessionKey?: string | null;
  controlModelConversationAgentId?: string | null;
};

export function selectedControlModelConversationForRoute(
  state: ChatControlModelConversationState,
  sessionKey: string,
  agentId?: string,
): ControlModelConversation | null {
  if (
    !state.controlModelConversation ||
    state.controlModelConversationSessionKey !== sessionKey ||
    (state.controlModelConversationAgentId ?? null) !== (agentId ?? null)
  ) {
    return null;
  }
  return state.controlModelConversation;
}
