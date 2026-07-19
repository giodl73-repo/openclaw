// Tests execution approval reply text and decision formatting.
import { createCatalogSnapshot } from "@openclaw/localization-core";
import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  APPROVAL_ENGLISH_MESSAGES,
  approvalLocalizationTestHelpers,
} from "./approval-localization.js";

vi.mock("./exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: vi.fn(
    (params: {
      channel?: string | null;
      channelLabel?: string | null;
      accountId?: string | null;
    }) => {
      const channel = (params.channel ?? "").trim().toLowerCase();
      const label = params.channelLabel ?? channel;
      const accountId = params.accountId?.trim();
      const accountPrefix =
        accountId && accountId !== "default"
          ? `channels.${channel}.accounts.${accountId}`
          : `channels.${channel}`;
      if (channel === "matrix") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\` or \`${accountPrefix}.dm.allowFrom\`; leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      if (channel === "discord") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      if (channel === "slack") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      if (channel === "telegram") {
        return `Approve it from the Web UI or terminal UI for now. ${label} supports native exec approvals for this account. Configure \`${accountPrefix}.execApprovals.approvers\`; if you leave it unset, OpenClaw can infer numeric owner IDs from \`${accountPrefix}.allowFrom\` or direct-message \`${accountPrefix}.defaultTo\` when possible. Leave \`${accountPrefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
      }
      return null;
    },
  ),
  listNativeExecApprovalClientLabels: vi.fn(() => ["Discord", "Matrix", "Slack", "Telegram"]),
  supportsNativeExecApprovalClient: vi.fn((channel?: string | null) =>
    ["discord", "matrix", "slack", "telegram"].includes((channel ?? "").trim().toLowerCase()),
  ),
}));

import {
  buildApprovalPresentation,
  buildApprovalPresentationFromActionDescriptors,
  buildExecApprovalActionDescriptors,
  buildExecApprovalCommandText,
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
  buildExecApprovalUnavailableReplyPayloadWithRenderer,
  buildTypedApprovalActionDescriptors,
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
  buildTypedExecApprovalPendingReplyPayloadWithRenderer,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
} from "./exec-approval-reply.js";

function withoutLocalizedLabels(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutLocalizedLabels);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "label")
      .map(([key, entry]) => [key, withoutLocalizedLabels(entry)]),
  );
}

describe("exec approval reply helpers", () => {
  const invalidReplyMetadataCases = [
    { name: "empty object", payload: {} },
    { name: "null channelData", payload: { channelData: null } },
    { name: "array channelData", payload: { channelData: [] } },
    { name: "null execApproval", payload: { channelData: { execApproval: null } } },
    { name: "array execApproval", payload: { channelData: { execApproval: [] } } },
    {
      name: "blank approval slug",
      payload: { channelData: { execApproval: { approvalId: "req-1", approvalSlug: "  " } } },
    },
    {
      name: "blank approval id",
      payload: { channelData: { execApproval: { approvalId: "  ", approvalSlug: "slug-1" } } },
    },
  ] as const;

  const unavailableReasonCases = [
    {
      reason: "initiating-platform-disabled" as const,
      channelLabel: "Slack",
      expected:
        "Exec approval is required, but native chat exec approvals are not configured on Slack.",
    },
    {
      reason: "initiating-platform-unsupported" as const,
      channelLabel: undefined,
      expected:
        "Exec approval is required, but this platform does not support chat exec approvals.",
    },
    {
      reason: "no-approval-route" as const,
      channelLabel: undefined,
      expected:
        "Exec approval is required, but no interactive approval client is currently available.",
    },
  ] as const;

  it("returns the approver DM notice text", () => {
    expect(getExecApprovalApproverDmNoticeText()).toBe(
      "Approval required. I sent approval DMs to the approvers for this account.",
    );
  });

  it("mentions Matrix in the fallback native approval guidance", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    }).text;
    expect(text).toContain("native chat approval client such as");
    expect(text).toContain("Discord");
    expect(text).toContain("Matrix");
    expect(text).toContain("Slack");
    expect(text).toContain("Telegram");
  });

  it("avoids repeating allowFrom guidance in the no-route fallback", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    }).text;

    expect(text).not.toContain(
      "Then retry the command. If those accounts already know your owner ID via allowFrom or owner config",
    );
    expect(text).toContain(
      "You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.",
    );
  });

  it("distinguishes node approval-inbox access from policy inspection", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
      host: "node",
      nodeId: "mac-1",
    }).text;

    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node mac-1`.",
    );
    expect(text).not.toContain("`openclaw dashboard --no-open` or `openclaw approvals get");
    expect(text).not.toContain("Open the approval inbox with");
    expect(text).not.toContain("exec-approvals list");
  });

  it("explains how to enable Matrix native approvals when Matrix is the initiating platform", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      channel: "matrix",
      channelLabel: "Matrix",
    }).text;

    expect(text).toContain("native chat exec approvals are not configured on Matrix");
    expect(text).toContain("Matrix supports native exec approvals for this account");
    expect(text).toContain("`channels.matrix.execApprovals.approvers`");
    expect(text).toContain("`channels.matrix.dm.allowFrom`");
  });

  it.each([
    {
      channel: "discord",
      channelLabel: "Discord",
      expected: "`commands.ownerAllowFrom`",
      unexpected: "`channels.discord.dm.allowFrom`",
    },
    {
      channel: "slack",
      channelLabel: "Slack",
      expected: "`commands.ownerAllowFrom`",
      unexpected: "`channels.slack.dm.allowFrom`",
    },
    {
      channel: "telegram",
      channelLabel: "Telegram",
      expected: "`channels.telegram.allowFrom`",
      unexpected: "`channels.telegram.dm.allowFrom`",
    },
  ])(
    "uses channel-specific disabled setup guidance for $channelLabel",
    ({ channel, channelLabel, expected, unexpected }) => {
      const text = buildExecApprovalUnavailableReplyPayload({
        reason: "initiating-platform-disabled",
        channel,
        channelLabel,
      }).text;

      expect(text).toContain(expected);
      expect(text).not.toContain(unexpected);
    },
  );

  it.each([
    {
      channel: "discord",
      channelLabel: "Discord",
      accountId: "work",
      expected: "`channels.discord.accounts.work.execApprovals.approvers`",
      unexpected: "`channels.discord.execApprovals.approvers`",
    },
    {
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work",
      expected: "`channels.slack.accounts.work.execApprovals.approvers`",
      unexpected: "`channels.slack.execApprovals.approvers`",
    },
    {
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "work",
      expected: "`channels.telegram.accounts.work.allowFrom`",
      unexpected: "`channels.telegram.allowFrom`",
    },
    {
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "work",
      expected: "`channels.matrix.accounts.work.dm.allowFrom`",
      unexpected: "`channels.matrix.dm.allowFrom`",
    },
  ])(
    "uses account-scoped disabled setup guidance for $channelLabel named account",
    ({ channel, channelLabel, accountId, expected, unexpected }) => {
      const text = buildExecApprovalUnavailableReplyPayload({
        reason: "initiating-platform-disabled",
        channel,
        channelLabel,
        accountId,
      }).text;

      expect(text).toContain(expected);
      expect(text).not.toContain(unexpected);
    },
  );

  it.each(invalidReplyMetadataCases)(
    "returns null for invalid reply metadata payload: $name",
    ({ payload }) => {
      expect(getExecApprovalReplyMetadata(payload as ReplyPayload)).toBeNull();
    },
  );

  it("normalizes reply metadata and filters invalid decisions", () => {
    expect(
      getExecApprovalReplyMetadata({
        channelData: {
          execApproval: {
            approvalId: " req-1 ",
            approvalSlug: " slug-1 ",
            agentId: " agent-1 ",
            allowedDecisions: ["allow-once", "bad", "deny", "allow-always", 3],
            sessionKey: " session-1 ",
          },
        },
      }),
    ).toEqual({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      approvalKind: "exec",
      agentId: "agent-1",
      allowedDecisions: ["allow-once", "deny", "allow-always"],
      sessionKey: "session-1",
    });
  });

  it("builds pending reply payloads with trimmed warning text and slug fallback", () => {
    const payload = buildTypedExecApprovalPendingReplyPayload({
      warningText: "  Heads up.  ",
      approvalId: "req-1",
      approvalSlug: "slug-1",
      command: "echo ok",
      cwd: "/tmp/work",
      host: "gateway",
      nodeId: "node-1",
      expiresAtMs: 2500,
      nowMs: 1000,
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-1",
        approvalSlug: "slug-1",
        approvalKind: "exec",
        agentId: undefined,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: undefined,
      },
    });
    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              action: {
                type: "approval",
                approvalId: "req-1",
                approvalKind: "exec",
                decision: "allow-once",
              },
              style: "success",
            },
            {
              label: "Allow Always",
              action: {
                type: "approval",
                approvalId: "req-1",
                approvalKind: "exec",
                decision: "allow-always",
              },
              style: "primary",
            },
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "req-1",
                approvalKind: "exec",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.interactive).toBeUndefined();
    expect(payload.text).toContain("Heads up.");
    expect(payload.text).toContain("```txt\n/approve slug-1 allow-once\n```");
    expect(payload.text).toContain("```sh\necho ok\n```");
    expect(payload.text).toContain("Host: gateway\nNode: node-1\nCWD: /tmp/work\nExpires in: 2s");
    expect(payload.text).toContain("Full id: `req-1`");
  });

  it("preserves the exact English pending output by default", () => {
    const payload = buildTypedExecApprovalPendingReplyPayload({
      warningText: "  Keep `rm -rf /srv/数据` literal.  ",
      approvalId: "req-完整-1",
      approvalSlug: "slug-1",
      command: `printf '%s' "数据"`,
      cwd: "/srv/数据",
      host: "gateway",
      nodeId: "node-原样",
      expiresAtMs: 2_500,
      nowMs: 1_000,
    });

    expect(payload.text).toBe(
      [
        "Keep `rm -rf /srv/数据` literal.",
        "Approval required.",
        "Run:",
        "```txt\n/approve slug-1 allow-once\n```",
        "Pending command:",
        "```sh\nprintf '%s' \"数据\"\n```",
        "Other options:",
        "```txt\n/approve slug-1 allow-always\n/approve slug-1 deny\n```",
        "Host: gateway\nNode: node-原样\nCWD: /srv/数据\nExpires in: 2s\nFull id: `req-完整-1`",
      ].join("\n\n"),
    );
  });

  it("renders a complete zh-CN pending reply while preserving literal and structured data", () => {
    const params = {
      warningText: "  Keep `rm -rf /srv/数据` literal.  ",
      approvalId: "req-完整-1",
      approvalSlug: "slug-1",
      command: `printf '%s' "数据"`,
      cwd: "/srv/数据",
      host: "gateway" as const,
      nodeId: "node-原样",
      expiresAtMs: 2_500,
      nowMs: 1_000,
    };
    const english = buildTypedExecApprovalPendingReplyPayload(params);
    const localized = buildTypedExecApprovalPendingReplyPayloadWithRenderer(
      params,
      approvalLocalizationTestHelpers.createRenderer({
        recipientLocale: "zh-CN",
      }),
    );

    expect(localized.text).toBe(
      [
        "Keep `rm -rf /srv/数据` literal.",
        "需要批准。",
        "执行：",
        "```txt\n/approve slug-1 allow-once\n```",
        "待执行命令：",
        "```sh\nprintf '%s' \"数据\"\n```",
        "其他选项：",
        "```txt\n/approve slug-1 allow-always\n/approve slug-1 deny\n```",
        "主机：gateway\n节点：node-原样\n工作目录：/srv/数据\n剩余有效时间：2 秒\n完整 ID：`req-完整-1`",
      ].join("\n\n"),
    );
    expect(localized.channelData).toEqual(english.channelData);
    expect(withoutLocalizedLabels(localized.presentation)).toEqual(
      withoutLocalizedLabels(english.presentation),
    );
    expect(localized.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "允许一次",
              action: {
                type: "approval",
                approvalId: "req-完整-1",
                approvalKind: "exec",
                decision: "allow-once",
              },
              style: "success",
            },
            {
              label: "始终允许",
              action: {
                type: "approval",
                approvalId: "req-完整-1",
                approvalKind: "exec",
                decision: "allow-always",
              },
              style: "primary",
            },
            {
              label: "拒绝",
              action: {
                type: "approval",
                approvalId: "req-完整-1",
                approvalKind: "exec",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("uses one English pending renderer for an incomplete selected catalog", () => {
    const params = {
      approvalId: "req-fallback",
      approvalSlug: "fallback",
      command: "echo safe",
      host: "gateway" as const,
    };
    const renderMessage = approvalLocalizationTestHelpers.createRenderer({
      recipientLocale: "zh-CN",
      snapshot: createCatalogSnapshot({
        catalogRevision: "approval-test:partial-pending",
        catalogs: {
          en: APPROVAL_ENGLISH_MESSAGES,
          "zh-CN": {
            "approval.reply.required": "需要批准。",
          },
        },
      }),
    });

    expect(buildTypedExecApprovalPendingReplyPayloadWithRenderer(params, renderMessage)).toEqual(
      buildTypedExecApprovalPendingReplyPayload(params),
    );
  });

  it.each(["not_a_locale", "de"])(
    "uses the complete English pending output for recipient locale %j",
    (recipientLocale) => {
      const params = {
        approvalId: "req-recipient-fallback",
        approvalSlug: "recipient-fallback",
        command: "echo safe",
        host: "gateway" as const,
      };

      expect(
        buildTypedExecApprovalPendingReplyPayloadWithRenderer(
          params,
          approvalLocalizationTestHelpers.createRenderer({ recipientLocale }),
        ),
      ).toEqual(buildTypedExecApprovalPendingReplyPayload(params));
    },
  );

  it("preserves shipped command/value controls in the legacy pending builder", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-legacy",
      approvalSlug: "legacy",
      allowedDecisions: ["deny"],
      command: "echo legacy",
      host: "gateway",
    });

    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve req-legacy deny" },
              value: "/approve req-legacy deny",
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("compacts structured cwd paths in pending reply payloads", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-home",
      approvalSlug: "slug-home",
      command: "pwd",
      cwd: "C:\\Users\\alice\\project",
      host: "gateway",
    });

    expect(payload.text).toContain("CWD: ~/project");
    expect(payload.text).not.toContain("C:\\Users\\alice");
  });

  it("omits allow-always actions when the effective policy requires approval every time", () => {
    const payload = buildTypedExecApprovalPendingReplyPayload({
      approvalId: "req-ask-always",
      approvalSlug: "slug-always",
      ask: "always",
      command: "echo ok",
      host: "gateway",
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-ask-always",
        approvalSlug: "slug-always",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    expect(payload.text).toContain("```txt\n/approve slug-always allow-once\n```");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.text).toContain("Allow Always is unavailable for this command.");
    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              action: {
                type: "approval",
                approvalId: "req-ask-always",
                approvalKind: "exec",
                decision: "allow-once",
              },
              style: "success",
            },
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "req-ask-always",
                approvalKind: "exec",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.interactive).toBeUndefined();
  });

  it("stores agent and session metadata for downstream suppression checks", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-meta",
      approvalSlug: "slug-meta",
      agentId: "ops-agent",
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      command: "echo ok",
      host: "gateway",
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-meta",
        approvalSlug: "slug-meta",
        approvalKind: "exec",
        agentId: "ops-agent",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      },
    });
  });

  it("uses a longer fence for commands containing triple backticks", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-2",
      approvalSlug: "slug-2",
      approvalCommandId: " req-cmd-2 ",
      command: "echo ```danger```",
      host: "sandbox",
    });

    expect(payload.text).toContain("```txt\n/approve req-cmd-2 allow-once\n```");
    expect(payload.text).toContain("````sh\necho ```danger```\n````");
    expect(payload.text).not.toContain("Expires in:");
  });

  it("clamps pending reply expiration to zero seconds", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-3",
      approvalSlug: "slug-3",
      command: "echo later",
      host: "gateway",
      expiresAtMs: 1000,
      nowMs: 3000,
    });

    expect(payload.text).toContain("Expires in: 0s");
  });

  it("formats longer approval windows in minutes", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-30m",
      approvalSlug: "slug-30m",
      command: "echo later",
      host: "gateway",
      expiresAtMs: 1_801_000,
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Expires in: 30m");
  });

  it("builds shared exec approval action descriptors and interactive replies", () => {
    expect(
      buildExecApprovalActionDescriptors({
        approvalCommandId: "req-1",
      }),
    ).toEqual([
      {
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve req-1 allow-once",
      },
      {
        decision: "allow-always",
        label: "Allow Always",
        style: "primary",
        command: "/approve req-1 allow-always",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve req-1 deny",
      },
    ]);

    expect(
      buildApprovalPresentation({
        approvalId: "req-1",
        allowedDecisions: ["deny"],
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve req-1 deny" },
              value: "/approve req-1 deny",
              style: "danger",
            },
          ],
        },
      ],
    });

    expect(
      buildApprovalPresentationFromActionDescriptors([
        {
          decision: "deny",
          label: "Deny",
          style: "danger",
          command: "/approve legacy-id deny",
        },
      ]),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve legacy-id deny" },
              value: "/approve legacy-id deny",
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("builds typed descriptors and presentations only through named typed builders", () => {
    expect(
      buildTypedApprovalActionDescriptors({
        approvalCommandId: "opaque-id",
        approvalKind: "plugin",
        allowedDecisions: ["deny"],
      }),
    ).toEqual([
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        action: {
          type: "approval",
          approvalId: "opaque-id",
          approvalKind: "plugin",
          decision: "deny",
        },
        command: "/approve opaque-id deny",
      },
    ]);

    expect(
      buildTypedApprovalPresentation({
        approvalId: "opaque-id",
        approvalKind: "plugin",
        allowedDecisions: ["deny"],
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "opaque-id",
                approvalKind: "plugin",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it.each([".", "..", "\uD800", "\uDC00", "broken-\uD800"])(
    "refuses malformed typed approval identity %j",
    (approvalId) => {
      expect(
        buildTypedApprovalActionDescriptors({
          approvalCommandId: approvalId,
          approvalKind: "exec",
          allowedDecisions: ["deny"],
        }),
      ).toEqual([]);
      expect(
        buildTypedApprovalPresentation({
          approvalId,
          approvalKind: "exec",
          allowedDecisions: ["deny"],
        }),
      ).toBeUndefined();
      expect(
        buildTypedExecApprovalPendingReplyPayload({
          approvalId,
          approvalSlug: "safe-slug",
          allowedDecisions: ["deny"],
          command: "echo safe",
          host: "gateway",
        }).presentation,
      ).toBeUndefined();
    },
  );

  it("preserves protocol-valid boundary whitespace in typed approval actions", () => {
    const approvalId = "\uFEFF";

    expect(
      buildTypedApprovalActionDescriptors({
        approvalCommandId: approvalId,
        approvalKind: "exec",
        allowedDecisions: ["deny"],
      }),
    ).toMatchObject([
      {
        action: { type: "approval", approvalId, approvalKind: "exec", decision: "deny" },
      },
    ]);
  });

  it("builds and parses shared exec approval command text", () => {
    expect(
      buildExecApprovalCommandText({
        approvalCommandId: "req-1",
        decision: "allow-always",
      }),
    ).toBe("/approve req-1 allow-always");

    expect(parseExecApprovalCommandText("/approve req-1 deny")).toEqual({
      approvalId: "req-1",
      decision: "deny",
    });
    expect(parseExecApprovalCommandText("approve req-1 allow-once")).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(parseExecApprovalCommandText("/approve@clover req-1 allow-once")).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(parseExecApprovalCommandText("  /approve req-1 always")).toEqual({
      approvalId: "req-1",
      decision: "allow-always",
    });
    expect(parseExecApprovalCommandText("/approve req-1 allow-always")).toEqual({
      approvalId: "req-1",
      decision: "allow-always",
    });
    expect(parseExecApprovalCommandText("/approve req-1 maybe")).toBeNull();
  });

  it("builds unavailable payloads for approver DMs", () => {
    expect(
      buildExecApprovalUnavailableReplyPayload({
        warningText: "  Careful.  ",
        reason: "no-approval-route",
        sentApproverDms: true,
      }),
    ).toEqual({
      text: "Careful.\n\nApproval required. I sent approval DMs to the approvers for this account.",
    });
  });

  it("renders a complete zh-CN unavailable reply", () => {
    const payload = buildExecApprovalUnavailableReplyPayloadWithRenderer(
      { reason: "no-approval-route" },
      approvalLocalizationTestHelpers.createRenderer({
        recipientLocale: "zh-CN",
      }),
    );

    expect(payload).toEqual({
      text: [
        "需要执行批准，但当前没有可用的交互式批准客户端。",
        "可从 Web UI 或终端 UI 批准，或启用原生聊天批准客户端，例如Discord、Matrix、Slack或Telegram。使用 `openclaw dashboard --no-open` 输出控制界面 URL，在浏览器中打开该 URL，然后使用批准收件箱。 如果这些帐户已通过 allowFrom 或所有者配置知道你的所有者 ID，OpenClaw 通常可以自动推断批准者。 然后重试该命令。只要所有者配置已识别批准者，通常可以不设置 execApprovals.approvers。",
      ].join("\n\n"),
    });
  });

  it("forces the whole unavailable reply to English when channel-owned setup copy is present", () => {
    const params = {
      reason: "initiating-platform-disabled" as const,
      channel: "matrix",
      channelLabel: "Matrix",
    };
    const english = buildExecApprovalUnavailableReplyPayload(params);
    const requestedChinese = buildExecApprovalUnavailableReplyPayloadWithRenderer(
      params,
      approvalLocalizationTestHelpers.createRenderer({
        recipientLocale: "zh-CN",
      }),
    );

    expect(requestedChinese).toEqual(english);
    expect(requestedChinese.text).toBe(
      "Exec approval is required, but native chat exec approvals are not configured on Matrix.\n\nApprove it from the Web UI or terminal UI for now. Matrix supports native exec approvals for this account. Configure `channels.matrix.execApprovals.approvers` or `channels.matrix.dm.allowFrom`; leave `channels.matrix.execApprovals.enabled` unset/`auto` or set it to `true`.",
    );
  });

  it.each(unavailableReasonCases)(
    "builds unavailable payload for reason $reason",
    ({ reason, channelLabel, expected }) => {
      expect(
        buildExecApprovalUnavailableReplyPayload({
          reason,
          channelLabel,
        }).text,
      ).toContain(expected);
    },
  );
});
