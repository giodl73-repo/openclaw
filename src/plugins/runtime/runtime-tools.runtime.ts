// Context-bound tool invocation for trusted in-process plugin workflows.
import { invokeGatewayTool } from "../../gateway/tools-invoke-shared.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";
import type { RuntimeToolInvokeParams, RuntimeToolInvokeResult } from "./types.js";

function resolveToolRuntimeConfig(context: OpenClawPluginToolContext) {
  return context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
}

/** Reuses the canonical invocation engine without crossing the Gateway RPC trust boundary. */
export async function invokeRuntimeTool(
  context: OpenClawPluginToolContext,
  params: RuntimeToolInvokeParams,
): Promise<RuntimeToolInvokeResult> {
  const cfg = resolveToolRuntimeConfig(context);
  if (!cfg) {
    throw new Error("Plugin tool invocation requires an active OpenClaw config.");
  }
  if (!context.sessionKey) {
    throw new Error("Plugin tool invocation requires an active session.");
  }

  const delivery = context.deliveryContext;
  const outcome = await invokeGatewayTool({
    cfg,
    input: {
      name: params.name,
      ...(params.action ? { action: params.action } : {}),
      args: params.args ?? {},
      sessionKey: context.sessionKey,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    },
    messageChannel: context.messageChannel ?? delivery?.channel,
    accountId: context.agentAccountId ?? delivery?.accountId,
    agentTo: delivery?.to,
    agentThreadId: delivery?.threadId === undefined ? undefined : String(delivery.threadId),
    modelProvider: context.activeModel?.provider,
    modelId: context.activeModel?.modelId,
    sessionId: context.sessionId,
    skillsSnapshot: context.skillsSnapshot,
    parentSkillInvocation: context.explicitSkillInvocation,
    parentRunId: context.runId,
    requesterSenderId: context.requesterSenderId,
    senderIsOwner: context.senderIsOwner,
    conversationReadOrigin: context.conversationReadOrigin,
    channelContext: context.requesterSenderId
      ? { sender: { id: context.requesterSenderId } }
      : undefined,
    toolCallIdPrefix: "plugin",
    approvalMode: "report",
    surface: "loopback",
    allowRequestedToolExpansion: false,
  });

  if (outcome.ok) {
    return {
      ok: true,
      toolName: outcome.toolName,
      output: outcome.result,
      source: outcome.source,
    };
  }
  return {
    ok: false,
    toolName: outcome.toolName || params.name,
    ...(outcome.error.requiresApproval ? { requiresApproval: true } : {}),
    error: {
      code: outcome.error.type,
      message: outcome.error.message,
    },
  };
}
