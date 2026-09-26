// @vitest-environment node
import { ControlModelCommandError } from "@openclaw/gateway-client/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activatedConversation,
  createHarness,
} from "../../../packages/gateway-client/src/model/conversation.test-support.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { controlModelQuestionPromptCommand } from "../pages/chat/chat-control-model-interactions.ts";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

const states: Array<ReturnType<typeof createQuestionPromptState>> = [];

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
});

describe("question prompt Control Model command", () => {
  it.each(["answer", "cancel"] as const)(
    "preserves the draft and displays a real model rejection during %s",
    async (action) => {
      const question = {
        id: "question-1",
        questions: [
          {
            questionId: "format",
            header: "Format",
            question: "Which format?",
            options: [{ label: "Detailed" }],
          },
        ],
        sessionKey: "agent:main:one",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        status: "pending" as const,
      };
      const harness = createHarness({ status: "connected", epoch: 1 }, { questions: [question] });
      const { model, conversation } = await activatedConversation(harness);
      try {
        await vi.waitFor(() =>
          expect(conversation.getSnapshot().questions).toContainEqual(
            expect.objectContaining({ id: question.id, status: "pending" }),
          ),
        );
        const request = vi.fn();
        const state = createQuestionPromptState(vi.fn());
        states.push(state);
        setQuestionPromptClient(state, { request });
        expect(
          handleQuestionPromptEvent(state, { event: "question.requested", payload: question }),
        ).toBe(true);
        const prompt = state.prompts.get(question.id);
        if (!prompt) {
          throw new Error("Expected a pending UI question");
        }
        prompt.drafts.set("format", { selected: new Set(["Detailed"]), freeText: "Keep my notes" });
        const adapter = controlModelQuestionPromptCommand(conversation, question.id, action);
        if (!adapter) {
          throw new Error("Expected an available Control Model question command");
        }
        const command = vi.fn(adapter);
        const pending = harness.defer("question.resolve");
        const submission =
          action === "answer"
            ? submitQuestionPrompt(state, question.id, { format: ["Detailed"] }, command)
            : cancelQuestionPrompt(state, question.id, command);
        expect(prompt.submitting).toBe(true);
        await vi.waitFor(() => expect(harness.callsFor("question.resolve")).toHaveLength(1));

        const message = "question 'question-1' was not found";
        pending.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message,
            details: { reason: "QUESTION_NOT_FOUND" },
          }),
        );
        await submission;

        expect(command).toHaveBeenCalledTimes(1);
        const rejection = command.mock.results[0]?.value;
        await expect(rejection).rejects.toBeInstanceOf(ControlModelCommandError);
        await expect(rejection).rejects.toMatchObject({
          category: "not-found",
          code: "INVALID_REQUEST",
          command: "question.resolve",
          message,
          details: { reason: "QUESTION_NOT_FOUND" },
          retryable: false,
        });
        expect(state.prompts.get(question.id)).toMatchObject({
          status: "pending",
          error: message,
          submitting: false,
          localResolutionConfirmed: false,
          answeredElsewhere: false,
        });
        expect(state.prompts.get(question.id)?.drafts.get("format")).toEqual({
          selected: new Set(["Detailed"]),
          freeText: "Keep my notes",
        });
        expect(harness.callsFor("question.resolve").map((call) => call.params)).toEqual([
          action === "answer"
            ? { id: question.id, answers: { answers: { format: ["Detailed"] } } }
            : { id: question.id, cancel: true },
        ]);
        expect(request).not.toHaveBeenCalled();
      } finally {
        model.dispose();
      }
    },
  );

  it("preserves prompt lifecycle state around the selected command", async () => {
    const request = vi.fn();
    const command = vi.fn(async (input) => ({
      status: "answered",
      answers: input.answers,
    }));
    const state = createQuestionPromptState(vi.fn());
    states.push(state);
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: {
        id: "question-1",
        questions: [
          {
            questionId: "format",
            header: "Format",
            question: "Which format?",
            options: [{ label: "Detailed" }],
          },
        ],
        sessionKey: "agent:main:one",
        createdAtMs: 1_000,
        expiresAtMs: Date.now() + 60_000,
        status: "pending",
      },
    });

    await submitQuestionPrompt(state, "question-1", { format: ["Detailed"] }, command);

    expect(command).toHaveBeenCalledWith({
      id: "question-1",
      expiresAtMs: expect.any(Number),
      answers: { answers: { format: ["Detailed"] } },
    });
    expect(request).not.toHaveBeenCalled();
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      localResolutionConfirmed: true,
      submitting: false,
    });
  });
});
