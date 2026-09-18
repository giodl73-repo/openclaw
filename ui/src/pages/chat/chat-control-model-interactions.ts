import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type {
  ControlModelConversationSnapshot,
  ControlModelRequestOptions,
} from "@openclaw/gateway-client/model";
import type { QuestionPromptCommand } from "../../app/question-prompt-command.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import {
  normalizeAgentId,
  resolveUiConversationIdentity,
  uiConversationMatches,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import {
  selectedControlModelConversationForRoute,
  type ChatControlModelConversationState,
} from "./chat-control-model.ts";

type QuestionConversation = {
  getSnapshot(): Pick<ControlModelConversationSnapshot, "questions" | "commandAvailability">;
  answerQuestion(
    id: string,
    answers: Readonly<Record<string, readonly string[]>>,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>>;
  cancelQuestion(
    id: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>>;
};

export function controlModelQuestionPromptCommand(
  conversation: QuestionConversation | null,
  id: string,
  action: "answer" | "cancel",
): QuestionPromptCommand | undefined {
  const snapshot = conversation?.getSnapshot();
  const available =
    action === "answer"
      ? snapshot?.commandAvailability.answerQuestion
      : snapshot?.commandAvailability.cancelQuestion;
  if (
    !conversation ||
    !snapshot ||
    !available ||
    !snapshot.questions.some((question) => question.id === id && question.status === "pending")
  ) {
    return undefined;
  }
  return async (request) => {
    const timeoutMs = Math.min(
      DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
      Math.max(0, request.expiresAtMs - Date.now()),
    );
    return action === "answer"
      ? conversation.answerQuestion(id, request.answers?.answers ?? {}, { timeoutMs })
      : conversation.cancelQuestion(id, { timeoutMs });
  };
}

/**
 * Shared global question state carries every agent's prompts; the selected
 * route only renders its own, so the agent restriction uses the route's own
 * conversation identity rather than the caller's optional agent. Only globally
 * scoped keys record an agent for the route, while a direct session key already
 * names one: reading it here keeps a normal `ask_user` prompt (session key plus
 * agent id) visible instead of reducing the route to unscoped rows. A prompt
 * with no session key is unscoped and belongs to whichever route reads it.
 *
 * Session identity is configuration-aware: a configured global alias such as
 * `agent:work:main` addresses the same conversation as a `global` prompt for
 * that agent, which a literal key comparison would drop.
 */
export function questionPromptsForRoute(
  host: UiSessionDefaultsHost & { sessionKey: string },
  prompts: readonly QuestionPrompt[],
  agentId?: string,
): QuestionPrompt[] {
  const routeAgentId = agentId?.trim()
    ? normalizeAgentId(agentId)
    : resolveUiConversationIdentity(host, host.sessionKey).agentId;
  return prompts.filter(
    (prompt) =>
      (prompt.sessionKey === undefined ||
        // An agent-less prompt belongs to whichever route reads it, so it is
        // compared under that route's agent rather than the default agent.
        uiConversationMatches(
          host,
          host.sessionKey,
          prompt.sessionKey,
          prompt.agentId ?? agentId,
          agentId,
        )) &&
      (routeAgentId
        ? !prompt.agentId || normalizeAgentId(prompt.agentId) === routeAgentId
        : !prompt.agentId),
  );
}

/**
 * Adapter for the selected route's model conversation. The chat question action
 * owner keeps its lifecycle; this only supplies the optional model command and
 * the projected artifacts for the transcript. The caller passes the currently
 * selected agent so a stale conversation cannot answer a newer route.
 */
export function controlModelChatInteractions(
  state: ChatControlModelConversationState,
  sessionKey: string,
  agentId?: string,
): {
  controlModelArtifacts?: ControlModelConversationSnapshot["artifacts"];
  questionCommand: (id: string, action: "answer" | "cancel") => QuestionPromptCommand | undefined;
} {
  const conversation = selectedControlModelConversationForRoute(state, sessionKey, agentId);
  return {
    controlModelArtifacts: conversation?.getSnapshot().artifacts,
    questionCommand: (id, action) => controlModelQuestionPromptCommand(conversation, id, action),
  };
}
