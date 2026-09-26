import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../../../extensions/msteams/channel-plugin-api.js";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

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
const conversation = "conversation:19:proof-current@thread.tacv2";
const foreign = "conversation:19:proof-other@thread.tacv2";
const graphTarget = "00000000-0000-4000-8000-000000000001/19:proof-current@thread.tacv2";
const inboundId = 1751234567890;
const context: ChannelThreadingToolContext = {
  currentChannelProvider: "msteams",
  currentChannelId: conversation,
  currentChatType: "group",
  currentMessageId: inboundId,
};

async function dispatch(
  action: "react" | "reactions" | "delete",
  args: Record<string, unknown>,
  toolContext?: ChannelThreadingToolContext,
) {
  const handleAction = msteamsPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("msteams actions.handleAction unavailable");
  }
  const params = normalizeMessageActionInput({
    action,
    args: { channel: "msteams", ...args },
    toolContext,
  });
  return await handleAction({
    channel: "msteams",
    action,
    cfg,
    params,
    toolContext,
    requesterAccountId: toolContext ? "default" : undefined,
  });
}

function expectNoTransport() {
  for (const mock of Object.values(transport)) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("native message normalization composed with Teams actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transport.reactMessageMSTeams.mockResolvedValue({ ok: true });
    transport.unreactMessageMSTeams.mockResolvedValue({ ok: true });
    transport.listReactionsMSTeams.mockResolvedValue({ reactions: [] });
    transport.deleteMessageMSTeams.mockResolvedValue({ conversationId: conversation });
  });

  it.each([
    { label: "implicit target", args: {}, toolContext: context, to: conversation },
    {
      label: "explicit target",
      args: { target: conversation },
      toolContext: context,
      to: conversation,
    },
    { label: "legacy to", args: { to: conversation }, toolContext: context, to: conversation },
    {
      label: "legacy channelId",
      args: { channelId: conversation },
      toolContext: context,
      to: conversation,
    },
    {
      label: "prefixed target and bare context",
      args: { target: conversation },
      toolContext: { ...context, currentChannelId: "19:proof-current@thread.tacv2" },
      to: conversation,
    },
    {
      label: "messaging context only",
      args: {},
      toolContext: {
        ...context,
        currentChannelId: undefined,
        currentMessagingTarget: conversation,
      },
      to: conversation,
    },
    {
      label: "channel Graph route",
      args: {},
      toolContext: {
        ...context,
        currentChatType: "channel" as const,
        currentGraphChannelId: graphTarget,
      },
      to: graphTarget,
    },
  ])("uses the inbound ID with $label", async ({ args, toolContext, to }) => {
    await expect(
      dispatch("react", { emoji: "like", ...args }, toolContext),
    ).resolves.not.toMatchObject({ isError: true });
    expect(transport.reactMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to,
      messageId: String(inboundId),
      reactionType: "like",
    });
    expect(transport.unreactMessageMSTeams).not.toHaveBeenCalled();
  });

  it("lists current reactions after core supplies the target", async () => {
    await expect(dispatch("reactions", {}, context)).resolves.not.toMatchObject({ isError: true });
    expect(transport.listReactionsMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: conversation,
      messageId: String(inboundId),
    });
  });

  it("removes a reaction from the current message", async () => {
    await expect(
      dispatch("react", { emoji: "like", remove: true }, context),
    ).resolves.not.toMatchObject({ isError: true });
    expect(transport.unreactMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: conversation,
      messageId: String(inboundId),
      reactionType: "like",
    });
    expect(transport.reactMessageMSTeams).not.toHaveBeenCalled();
  });

  it.each(["react", "reactions"] as const)(
    "rejects a foreign target for %s without an explicit ID",
    async (action) => {
      await expect(
        dispatch(action, { target: foreign, emoji: "like" }, context),
      ).resolves.toMatchObject({ isError: true });
      expectNoTransport();
    },
  );

  it.each([
    { label: "same conversation", target: conversation, toolContext: context },
    { label: "foreign conversation", target: foreign, toolContext: context },
    { label: "no inbound turn", target: foreign, toolContext: undefined },
  ])("preserves an explicit ID with $label", async ({ target, toolContext }) => {
    await expect(
      dispatch("react", { target, messageId: "explicit-message", emoji: "heart" }, toolContext),
    ).resolves.not.toMatchObject({ isError: true });
    expect(transport.reactMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: target,
      messageId: "explicit-message",
      reactionType: "heart",
    });
  });

  it.each([
    { label: "no current conversation", toolContext: { ...context, currentChannelId: undefined } },
    { label: "no inbound message", toolContext: { ...context, currentMessageId: undefined } },
    { label: "no inbound turn", toolContext: undefined },
  ])("rejects implicit message fallback with $label", async ({ toolContext }) => {
    await expect(
      dispatch("react", { target: conversation, emoji: "like" }, toolContext),
    ).resolves.toMatchObject({ isError: true });
    expectNoTransport();
  });

  it("rejects missing target and context before dispatch", async () => {
    await expect(dispatch("react", { emoji: "like" })).rejects.toThrow(/target/);
    expectNoTransport();
  });

  it("never supplies the inbound ID to delete", async () => {
    await expect(dispatch("delete", {}, context)).resolves.toMatchObject({ isError: true });
    expectNoTransport();
  });

  it("still permits delete with an explicit ID", async () => {
    await expect(
      dispatch("delete", { messageId: "explicit-delete" }, context),
    ).resolves.not.toMatchObject({ isError: true });
    expect(transport.deleteMessageMSTeams).toHaveBeenCalledExactlyOnceWith({
      cfg,
      to: conversation,
      activityId: "explicit-delete",
    });
  });
});
