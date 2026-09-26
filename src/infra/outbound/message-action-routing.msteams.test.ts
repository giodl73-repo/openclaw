import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../../../extensions/msteams/channel-plugin-api.js";
import type {
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { getToolResult, runMessageAction } from "./message-action-runner.js";
import { resetDirectoryCache } from "./target-resolver.js";

const transport = vi.hoisted(() => ({
  reactMessageMSTeams: vi.fn(),
  unreactMessageMSTeams: vi.fn(),
  listReactionsMSTeams: vi.fn(),
  deleteMessageMSTeams: vi.fn(),
}));

vi.mock("../../../extensions/msteams/src/channel.runtime.js", () => ({
  msTeamsChannelRuntime: transport,
}));

const cfg: OpenClawConfig = {
  channels: { msteams: { groupPolicy: "open", dmPolicy: "open" } },
};
const conversation = "conversation:19:router-current@thread.tacv2";
const foreign = "conversation:19:router-other@thread.tacv2";
const graphTarget = "00000000-0000-4000-8000-000000000002/19:router-current@thread.tacv2";
const context: ChannelThreadingToolContext = {
  currentChannelProvider: "msteams",
  currentChannelId: conversation,
  currentChatType: "group",
  currentMessageId: 1751234567890,
};

async function dispatch(
  action: "react" | "reactions" | "delete",
  params: Record<string, unknown>,
  toolContext = context,
  abortSignal?: AbortSignal,
) {
  const result = await runMessageAction({
    cfg,
    action,
    params: { channel: "msteams", ...params },
    toolContext,
    requesterAccountId: "default",
    abortSignal,
  });
  expect(result).toMatchObject({ kind: "action", handledBy: "plugin", dryRun: false });
  const toolResult = getToolResult(result);
  expect(toolResult).toBeDefined();
  return toolResult;
}

function expectNoTransport() {
  for (const mock of Object.values(transport)) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("native Teams registration and message-action routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transport.reactMessageMSTeams.mockResolvedValue({ ok: true });
    transport.unreactMessageMSTeams.mockResolvedValue({ ok: true });
    transport.listReactionsMSTeams.mockResolvedValue({ reactions: [] });
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({ id: "msteams", origin: "bundled" });
    builder.registry.plugins.push(record);
    builder.createApi(record, { config: cfg, registrationMode: "full" }).registerChannel({
      // Registration erases the channel-specific capabilities probe result type.
      plugin: msteamsPlugin as ChannelPlugin,
    });
    expect(builder.registry.diagnostics).toEqual([]);
    setActivePluginRegistry(builder.registry);
    expect(builder.registry.channels).toHaveLength(1);
    expect(builder.registry.channels[0]?.captureReadAuthority?.()?.()).toBe(true);
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetDirectoryCache();
  });

  it.each([
    { label: "implicit group", params: {}, toolContext: context, to: conversation },
    {
      label: "prefixed target with bare context",
      params: { target: conversation },
      toolContext: { ...context, currentChannelId: "19:router-current@thread.tacv2" },
      to: conversation,
    },
    {
      label: "implicit channel Graph route",
      params: {},
      toolContext: {
        ...context,
        currentChatType: "channel" as const,
        currentGraphChannelId: graphTarget,
      },
      to: graphTarget,
    },
  ])("routes $label to the inbound message", async ({ params, toolContext, to }) => {
    await expect(
      dispatch("react", { emoji: "like", ...params }, toolContext),
    ).resolves.not.toMatchObject({ isError: true });
    expect(transport.reactMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to,
      messageId: String(context.currentMessageId),
      reactionType: "like",
    });
  });

  it("lists reactions through registered read authority", async () => {
    await expect(dispatch("reactions", {})).resolves.not.toMatchObject({ isError: true });
    expect(transport.listReactionsMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: conversation,
      messageId: String(context.currentMessageId),
    });
  });

  it("routes removal without adding a reaction", async () => {
    await expect(dispatch("react", { emoji: "heart", remove: true })).resolves.not.toMatchObject({
      isError: true,
    });
    expect(transport.unreactMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: conversation,
      messageId: String(context.currentMessageId),
      reactionType: "heart",
    });
    expect(transport.reactMessageMSTeams).not.toHaveBeenCalled();
  });

  it("preserves explicit foreign message identity", async () => {
    await expect(
      dispatch("react", { target: foreign, messageId: "explicit-message", emoji: "like" }),
    ).resolves.not.toMatchObject({ isError: true });
    expect(transport.reactMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: foreign,
      messageId: "explicit-message",
      reactionType: "like",
    });
  });

  it("refuses foreign message fallback after routing", async () => {
    await expect(dispatch("react", { target: foreign, emoji: "like" })).resolves.toMatchObject({
      isError: true,
    });
    expectNoTransport();
  });

  it("does not infer a destructive message ID", async () => {
    await expect(dispatch("delete", {})).resolves.toMatchObject({ isError: true });
    expectNoTransport();
  });

  it("rejects an already cancelled action before transport", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic caller cancellation"));
    await expect(dispatch("react", { emoji: "like" }, context, controller.signal)).rejects.toThrow(
      /cancel|abort/i,
    );
    expectNoTransport();
  });
});
