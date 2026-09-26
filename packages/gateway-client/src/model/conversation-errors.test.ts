import { describe, expect, it } from "vitest";
import { GatewayProtocolRequestError } from "../protocol-request.js";
import { activatedConversation, createHarness } from "./conversation.test-support.js";

describe("conversation command error classification", () => {
  it.each([
    ["APPROVAL_NOT_FOUND", "approval not found", "not-found"],
    ["APPROVAL_ALREADY_RESOLVED", "approval already resolved", "conflict"],
  ] as const)(
    "classifies Gateway %s after a locally pending approval",
    async (reason, message, category) => {
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        {
          approvalReplay: {
            sessionKey: "agent:main:one",
            approvals: [
              {
                id: "approval-1",
                status: "pending",
                sessionKey: "agent:main:one",
                presentation: { kind: "exec", allowedDecisions: ["allow-once", "deny"] },
              },
            ],
            truncated: false,
          },
        },
      );
      const { model, conversation } = await activatedConversation(harness);
      try {
        harness.queue(
          "approval.resolve",
          new GatewayProtocolRequestError({
            code: "INVALID_REQUEST",
            message,
            details: { reason },
          }),
        );
        await expect(
          conversation.resolveApproval("approval-1", "allow-once"),
        ).rejects.toMatchObject({
          category,
          code: "INVALID_REQUEST",
          message,
          command: "approval.resolve",
          retryable: false,
        });
        expect(harness.callsFor("approval.resolve")).toHaveLength(1);
      } finally {
        model.dispose();
      }
    },
  );

  it.each(["answer", "cancel"] as const)(
    "classifies a missing Gateway question during %s",
    async (action) => {
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        { questions: [{ id: "question-1", status: "pending", sessionKey: "agent:main:one" }] },
      );
      const { model, conversation } = await activatedConversation(harness);
      try {
        harness.queue(
          "question.resolve",
          new GatewayProtocolRequestError({
            code: "INVALID_REQUEST",
            message: "question 'question-1' was not found",
            details: { reason: "QUESTION_NOT_FOUND" },
          }),
        );
        const result =
          action === "answer"
            ? conversation.answerQuestion("question-1", { choice: ["yes"] })
            : conversation.cancelQuestion("question-1");
        await expect(result).rejects.toMatchObject({
          category: "not-found",
          code: "INVALID_REQUEST",
          message: "question 'question-1' was not found",
          command: "question.resolve",
          retryable: false,
        });
        expect(harness.callsFor("question.resolve")).toHaveLength(1);
      } finally {
        model.dispose();
      }
    },
  );

  it.each([
    ["FORBIDDEN", { reason: "APPROVAL_NOT_FOUND" }, "forbidden"],
    ["AUTH_UNAUTHORIZED", { reason: "APPROVAL_ALREADY_RESOLVED" }, "forbidden"],
    ["INVALID_REQUEST", { reason: "QUESTION_FORBIDDEN" }, "forbidden"],
    ["INVALID_REQUEST", { reason: "APPROVAL_NOT_FOUND_UNAUTHORIZED" }, "forbidden"],
    ["INVALID_REQUEST", { reason: "QUESTION_INVALID_ANSWERS" }, "invalid-input"],
    ["INVALID_REQUEST", { reason: "APPROVAL_NOT_FOUND_SUFFIX" }, "invalid-input"],
    ["INVALID_REQUEST", undefined, "invalid-input"],
    ["INVALID_REQUEST", { reason: 42 }, "invalid-input"],
    ["INVALID_REQUEST", ["APPROVAL_NOT_FOUND"], "invalid-input"],
    ["INVALID_APPROVAL_INPUT", { reason: "APPROVAL_NOT_FOUND" }, "invalid-input"],
    ["ABORTERROR", { reason: "APPROVAL_NOT_FOUND" }, "aborted"],
  ] as const)("preserves %s / %j classification as %s", async (code, details, category) => {
    const { harness, model, conversation } = await activatedConversation();
    try {
      harness.queue("chat.send", new GatewayProtocolRequestError({ code, details }));
      await expect(conversation.send("test")).rejects.toMatchObject({ category, code });
    } finally {
      model.dispose();
    }
  });

  it.each([
    Object.assign(new Error("cancelled"), {
      name: "AbortError",
      code: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    }),
    Object.assign(new DOMException("cancelled", "AbortError"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "QUESTION_NOT_FOUND" },
    }),
  ])("preserves abort exception precedence ($name)", async (error) => {
    const { harness, model, conversation } = await activatedConversation();
    try {
      harness.queue("chat.send", error);
      await expect(conversation.send("test")).rejects.toMatchObject({ category: "aborted" });
    } finally {
      model.dispose();
    }
  });

  it.each([
    { retryAfterMs: 123, details: { reason: "APPROVAL_ALREADY_RESOLVED", retryAfterMs: 456 } },
    { details: { reason: "APPROVAL_ALREADY_RESOLVED", retryAfterMs: 123 } },
  ])("preserves retry metadata and bounded messages (%j)", async (metadata) => {
    const { harness, model, conversation } = await activatedConversation();
    try {
      harness.queue(
        "chat.send",
        Object.assign(new Error("x".repeat(300)), {
          gatewayCode: "INVALID_REQUEST",
          retryable: true,
          ...metadata,
        }),
      );
      await expect(conversation.send("test")).rejects.toMatchObject({
        category: "conflict",
        code: "INVALID_REQUEST",
        message: "x".repeat(240),
        command: "chat.send",
        retryable: true,
        retryAfterMs: 123,
      });
    } finally {
      model.dispose();
    }
  });
});
