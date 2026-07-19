// Covers approval delivery destination labels and reroute notices.
import { describe, expect, it } from "vitest";
import { approvalLocalizationTestHelpers } from "./approval-localization.js";
import {
  describeApprovalDeliveryDestination,
  resolveApprovalDeliveryFailedNoticeText,
  resolveApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";

describe("describeApprovalDeliveryDestination", () => {
  it("labels approver-DM-only delivery as channel DMs", () => {
    expect(
      describeApprovalDeliveryDestination({
        channelLabel: "Telegram",
        deliveredTargets: [
          {
            surface: "approver-dm",
            target: { to: "111" },
            reason: "fallback",
          },
        ],
      }),
    ).toBe("Telegram DMs");
  });

  it("labels mixed-surface delivery as the channel itself", () => {
    expect(
      describeApprovalDeliveryDestination({
        channelLabel: "Matrix",
        deliveredTargets: [
          {
            surface: "origin",
            target: { to: "room:!abc:example.com" },
            reason: "preferred",
          },
        ],
      }),
    ).toBe("Matrix");
  });
});

describe("resolveApprovalRoutedElsewhereNoticeText", () => {
  it("reports sorted unique destinations", () => {
    expect(
      resolveApprovalRoutedElsewhereNoticeText(["Telegram DMs", "Matrix DMs", "Telegram DMs"]),
    ).toBe(
      "Approval required. I sent the approval request to Matrix DMs or Telegram DMs, not this chat.",
    );
  });

  it("suppresses the notice when there are no destinations", () => {
    expect(resolveApprovalRoutedElsewhereNoticeText([])).toBeNull();
  });

  it("renders complete zh-CN route and recovery notices while preserving commands", () => {
    const renderMessage = approvalLocalizationTestHelpers.createRenderer({
      recipientLocale: "zh-CN",
    });
    const telegramDm = describeApprovalDeliveryDestination({
      channelLabel: "Telegram",
      deliveredTargets: [
        {
          surface: "approver-dm",
          target: { to: "owner-原样" },
          reason: "preferred",
        },
      ],
      renderMessage,
    });
    const matrixDm = describeApprovalDeliveryDestination({
      channelLabel: "Matrix",
      deliveredTargets: [
        {
          surface: "approver-dm",
          target: { to: "owner-2" },
          reason: "fallback",
        },
      ],
      renderMessage,
    });

    expect(telegramDm).toBe("Telegram 私信");
    expect(resolveApprovalRoutedElsewhereNoticeText([telegramDm, matrixDm], renderMessage)).toBe(
      "需要批准。我已将批准请求发送到Matrix 私信或Telegram 私信，而不是此聊天。",
    );
    expect(
      resolveApprovalDeliveryFailedNoticeText({
        approvalId: "approval-完整-123456",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
        renderMessage,
      }),
    ).toBe(
      [
        "需要批准。我无法发送原生批准请求。",
        "请回复：/approve approval allow-once|deny",
        "如果短代码有歧义，请在 /approve 中使用完整 ID。",
      ].join("\n"),
    );
  });

  it("preserves the exact English failed-delivery output by default", () => {
    expect(
      resolveApprovalDeliveryFailedNoticeText({
        approvalId: "approval-123456",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      }),
    ).toBe(
      [
        "Approval required. I could not deliver the native approval request.",
        "Reply with: /approve approval allow-once|deny",
        "If the short code is ambiguous, use the full id in /approve.",
      ].join("\n"),
    );
  });
});
