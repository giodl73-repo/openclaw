import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type {
  ControlModelConversationSnapshot,
  ControlModelRequestOptions,
} from "@openclaw/gateway-client/model";
import type { QuestionPromptCommand } from "../../app/question-prompt-command.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
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
 * route only renders its own. Without a route agent only unscoped rows match,
 * so another agent's prompts cannot leak into a direct session. A prompt with
 * no session key is unscoped and stays visible on every route.
 */
export function questionPromptsForRoute(
  prompts: readonly QuestionPrompt[],
  sessionKey: string,
  agentId?: string,
): QuestionPrompt[] {
  const normalizedAgentId = agentId?.trim().toLowerCase();
  return prompts.filter(
    (prompt) =>
      (prompt.sessionKey === undefined ||
        areUiSessionKeysEquivalent(prompt.sessionKey, sessionKey)) &&
      (normalizedAgentId
        ? !prompt.agentId || prompt.agentId.trim().toLowerCase() === normalizedAgentId
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
