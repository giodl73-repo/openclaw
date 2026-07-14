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
});
