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

  it("leaves an explicit invocation open when fallback continues", async () => {
    const recordEvent = vi.fn();
    let decideFallback: ((decision: "continue" | "terminal") => Promise<void> | void) | undefined;
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
      registerFallbackDecisionHandler: (handler) => {
        decideFallback = handler;
      },
    });

    expect(recordEvent).not.toHaveBeenCalledWith("skill.invocation.completed", expect.anything());
    await decideFallback?.("continue");
    expect(recordEvent).not.toHaveBeenCalledWith("skill.invocation.completed", expect.anything());
  });

  it("closes an explicit invocation when an earlier fallback candidate succeeds", async () => {
    const recordEvent = vi.fn();
    const flush = vi.fn().mockRejectedValue(new Error("trajectory unavailable"));
    let decideFallback: ((decision: "continue" | "terminal") => Promise<void> | void) | undefined;
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
      trajectoryRecorder: { recordEvent, flush },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: true,
      explicitSkillInvocation: {
        invocationId: "skill-1",
        commandName: "support",
        skillName: "customer-support",
      },
      registerFallbackDecisionHandler: (handler) => {
        decideFallback = handler;
      },
    });

    await expect(decideFallback?.("terminal")).resolves.toBeUndefined();
    expect(recordEvent).toHaveBeenCalledWith(
      "skill.invocation.completed",
      expect.objectContaining({ status: "success" }),
    );
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
