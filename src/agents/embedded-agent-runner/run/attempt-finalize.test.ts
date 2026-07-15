import { describe, expect, it, vi } from "vitest";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt", () => {
  it("records the terminal outcome for an explicit skill invocation", () => {
    const recordEvent = vi.fn();
    const result = {
      assistantTexts: ["done"],
      toolMetas: [],
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      aborted: false,
      externalAbort: false,
      timedOut: false,
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
      explicitSkillInvocation: {
        invocationId: "skill-1",
        commandName: "support",
        skillName: "customer-support",
        skillSource: "workspace",
      },
    });

    expect(recordEvent).toHaveBeenCalledWith("skill.invocation.completed", {
      invocationId: "skill-1",
      commandName: "support",
      skillName: "customer-support",
      skillSource: "workspace",
      activation: "command",
      caller: "inbound",
      status: "success",
    });
  });

  it("records child skill lineage as orchestration", () => {
    const recordEvent = vi.fn();
    const result = {
      assistantTexts: ["done"],
      toolMetas: [],
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      aborted: false,
      externalAbort: false,
      timedOut: false,
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
      explicitSkillInvocation: {
        invocationId: "skill-child",
        commandName: "invoice-paid",
        skillName: "invoice-paid",
        parentInvocationId: "skill-parent",
        parentRunId: "run-parent",
      },
    });

    expect(recordEvent).toHaveBeenCalledWith(
      "skill.invocation.completed",
      expect.objectContaining({
        invocationId: "skill-child",
        parentInvocationId: "skill-parent",
        parentRunId: "run-parent",
        activation: "orchestration",
        caller: "skill",
        status: "success",
      }),
    );
  });

  it("leaves an explicit invocation open before the final fallback attempt", () => {
    const recordEvent = vi.fn();
    const result = {
      assistantTexts: [],
      toolMetas: [],
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      aborted: false,
      externalAbort: false,
      timedOut: false,
      promptError: new Error("try the fallback"),
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: false,
      explicitSkillInvocation: {
        invocationId: "skill-1",
        commandName: "support",
        skillName: "customer-support",
      },
      isFinalFallbackAttempt: false,
    });

    expect(recordEvent).not.toHaveBeenCalledWith("skill.invocation.completed", expect.anything());
  });

  it("records root-agent child skill lineage as orchestration", () => {
    const recordEvent = vi.fn();
    const result = {
      assistantTexts: ["done"],
      toolMetas: [],
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      aborted: false,
      externalAbort: false,
      timedOut: false,
    } as unknown as EmbeddedRunAttemptResult;

    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
      explicitSkillInvocation: {
        invocationId: "skill-child",
        commandName: "invoice-paid",
        skillName: "invoice-paid",
        parentRunId: "run-parent",
      },
    });

    expect(recordEvent).toHaveBeenCalledWith(
      "skill.invocation.completed",
      expect.objectContaining({ activation: "orchestration", caller: "agent" }),
    );
  });
});
