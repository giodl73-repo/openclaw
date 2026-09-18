import { cancelQuestionPrompt, submitQuestionPrompt } from "../../app/question-prompt.ts";
import type { QuestionPromptCommand } from "../../app/question-prompt-command.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.ts";

type QuestionActionOptions = {
  state: Pick<ChatPageHost, "sessionKey" | "connectionEpoch" | "handleSendChat" | "lastError">;
  questionState: Parameters<typeof submitQuestionPrompt>[0];
  canSend: boolean;
  isCurrent: () => boolean;
  /** Control Model adapter; returns undefined whenever the raw path still owns the prompt. */
  questionCommand?: (id: string, action: "answer" | "cancel") => QuestionPromptCommand | undefined;
};

export function createChatQuestionActions({
  state,
  questionState,
  canSend,
  isCurrent,
  questionCommand,
}: QuestionActionOptions): Pick<
  ChatProps,
  | "onGatewayQuestionChange"
  | "onGatewayQuestionSubmit"
  | "onGatewayQuestionSkip"
  | "onAsyncQuestionSubmit"
> {
  const sessionKey = state.sessionKey;
  const connectionEpoch = state.connectionEpoch;
  const ownsSubmission = () =>
    state.sessionKey === sessionKey && state.connectionEpoch === connectionEpoch && isCurrent();
  return {
    onGatewayQuestionChange: questionState.onChange,
    onGatewayQuestionSubmit: (id, answers) =>
      submitQuestionPrompt(questionState, id, answers, questionCommand?.(id, "answer")),
    onGatewayQuestionSkip: (id) =>
      cancelQuestionPrompt(questionState, id, questionCommand?.(id, "cancel")),
    onAsyncQuestionSubmit: canSend
      ? async (message) => {
          if (!ownsSubmission()) {
            return false;
          }
          let outboxAdmitted = false;
          let accepted: boolean | void = undefined;
          try {
            accepted = await state.handleSendChat(message, {
              followUpMode: "steer",
              replyTargetOverride: null,
              onOutboxAdmitted: () => {
                outboxAdmitted = true;
              },
            });
          } catch (error) {
            if (!outboxAdmitted) {
              throw error;
            }
          }
          if (!ownsSubmission()) {
            return false;
          }
          if (!outboxAdmitted && !accepted && state.lastError) {
            throw new Error(state.lastError);
          }
          return outboxAdmitted || accepted === true;
        }
      : undefined,
  };
}
