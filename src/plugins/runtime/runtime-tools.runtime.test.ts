import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeGatewayTool = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/tools-invoke-shared.js", () => ({ invokeGatewayTool }));

import { invokeRuntimeTool } from "./runtime-tools.runtime.js";

describe("invokeRuntimeTool", () => {
  beforeEach(() => {
    invokeGatewayTool.mockReset();
  });

  it("preserves trusted caller policy context without expanding the tool surface", async () => {
    invokeGatewayTool.mockResolvedValue({
      ok: true,
      status: 200,
      toolName: "message",
      source: "core",
      result: { sent: true },
    });
    const config = {};
    const context = {
      getRuntimeConfig: () => config,
      agentId: "main",
      sessionKey: "agent:main:email:case-42",
      sessionId: "session-case-42",
      messageChannel: "email",
      agentAccountId: "support",
      deliveryContext: {
        channel: "email",
        accountId: "support",
        to: "customer@example.com",
        threadId: "thread-42",
      },
      requesterSenderId: "customer-42",
      senderIsOwner: false,
      conversationReadOrigin: "delegated" as const,
      activeModel: { provider: "openai", modelId: "gpt-5.6-luna" },
      runId: "run-parent",
      skillsSnapshot: { prompt: "", skills: [{ name: "verify-customer" }], version: 1 },
      explicitSkillInvocation: {
        invocationId: "inv-parent",
        commandName: "support-case",
        skillName: "support-case",
        executionHints: { usesSkills: ["verify-customer"] },
      },
    };

    await expect(
      invokeRuntimeTool(context, {
        name: "message",
        action: "send",
        args: { message: "Resolved" },
        idempotencyKey: "lobster:flow-1:notify",
      }),
    ).resolves.toEqual({
      ok: true,
      toolName: "message",
      output: { sent: true },
      source: "core",
    });

    expect(invokeGatewayTool).toHaveBeenCalledWith({
      cfg: config,
      input: {
        name: "message",
        action: "send",
        args: { message: "Resolved" },
        sessionKey: "agent:main:email:case-42",
        agentId: "main",
        idempotencyKey: "lobster:flow-1:notify",
      },
      messageChannel: "email",
      accountId: "support",
      agentTo: "customer@example.com",
      agentThreadId: "thread-42",
      modelProvider: "openai",
      modelId: "gpt-5.6-luna",
      sessionId: "session-case-42",
      skillsSnapshot: context.skillsSnapshot,
      parentSkillInvocation: context.explicitSkillInvocation,
      parentRunId: "run-parent",
      requesterSenderId: "customer-42",
      senderIsOwner: false,
      conversationReadOrigin: "delegated",
      channelContext: { sender: { id: "customer-42" } },
      toolCallIdPrefix: "plugin",
      approvalMode: "report",
      surface: "loopback",
      allowRequestedToolExpansion: false,
    });
  });

  it("returns policy failures without weakening them", async () => {
    invokeGatewayTool.mockResolvedValue({
      ok: false,
      status: 404,
      toolName: "message",
      error: { type: "not_found", message: "Tool not available: message" },
    });

    await expect(
      invokeRuntimeTool(
        { config: {}, sessionKey: "agent:main:email:case-42" },
        { name: "message" },
      ),
    ).resolves.toEqual({
      ok: false,
      toolName: "message",
      error: { code: "not_found", message: "Tool not available: message" },
    });
  });
});
