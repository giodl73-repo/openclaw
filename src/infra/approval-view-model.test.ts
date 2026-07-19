import {
  createCatalogSnapshot,
  createLocalizationContext,
  validateCatalog,
} from "@openclaw/localization-core";
// Tests approval view model formatting for prompts and decisions.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ENGLISH_MESSAGES,
  APPROVAL_ZH_CN_MESSAGES,
  approvalLocalizationTestHelpers,
} from "./approval-localization.js";
import {
  buildExpiredApprovalView,
  buildPendingApprovalView,
  buildResolvedApprovalView,
  resolveApprovalRequestKind,
} from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

describe("buildPendingApprovalView", () => {
  it("preserves the current English approval presentation by default", () => {
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "echo hello",
        agentId: "main",
        cwd: "/workspace",
        host: "gateway",
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view).toMatchObject({
      title: "Exec Approval Required",
      description: "A command needs your approval.",
      metadata: [
        { label: "Agent", value: "main" },
        { label: "CWD", value: "/workspace" },
        { label: "Host", value: "gateway" },
      ],
    });
    expect(
      view.actions.map(({ label, command, decision }) => ({ label, command, decision })),
    ).toEqual([
      {
        label: "Allow Once",
        command: "/approve approval-id allow-once",
        decision: "allow-once",
      },
      {
        label: "Allow Always",
        command: "/approve approval-id allow-always",
        decision: "allow-always",
      },
      {
        label: "Deny",
        command: "/approve approval-id deny",
        decision: "deny",
      },
    ]);
  });

  it("localizes product-owned labels without changing approval literals or actions", () => {
    const source = APPROVAL_ENGLISH_MESSAGES;
    const candidate = APPROVAL_ZH_CN_MESSAGES;
    expect(validateCatalog({ namespace: "approval", source, candidate })).toEqual([]);
    const renderMessage = approvalLocalizationTestHelpers.createRenderer({
      context: createLocalizationContext({
        locale: "zh-CN",
        source: "explicit-recipient",
        audience: "operator",
      }),
      snapshot: createCatalogSnapshot({
        catalogRevision: "approval-test:zh-CN",
        catalogs: { en: source, "zh-CN": candidate },
      }),
    });
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "rm -rf /tmp/example",
        agentId: "main",
        cwd: "/workspace",
        host: "gateway",
      },
    };

    const view = buildPendingApprovalView(request, { renderMessage });

    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.title).toBe("需要执行批准");
    expect(view.description).toBe("一个命令需要你的批准。");
    expect(view.metadata).toEqual([
      { label: "代理", value: "main" },
      { label: "工作目录", value: "/workspace" },
      { label: "主机", value: "gateway" },
    ]);
    expect(view.commandText).toBe("rm -rf /tmp/example");
    expect(view.actions.map(({ label, command, action }) => ({ label, command, action }))).toEqual([
      {
        label: "允许一次",
        command: "/approve approval-id allow-once",
        action: {
          type: "approval",
          approvalId: "approval-id",
          approvalKind: "exec",
          decision: "allow-once",
        },
      },
      {
        label: "始终允许",
        command: "/approve approval-id allow-always",
        action: {
          type: "approval",
          approvalId: "approval-id",
          approvalKind: "exec",
          decision: "allow-always",
        },
      },
      {
        label: "拒绝",
        command: "/approve approval-id deny",
        action: {
          type: "approval",
          approvalId: "approval-id",
          approvalKind: "exec",
          decision: "deny",
        },
      },
    ]);
  });

  it("passes command analysis through exec approval views", () => {
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: 'ls | grep "stuff" | python -c \'print("hi")\'',
        host: "node",
        ask: "always",
        commandAnalysis: {
          commandCount: 1,
          nestedCommandCount: 0,
          riskKinds: ["inline-eval"],
          warningLines: ["Contains inline-eval: python -c"],
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("exec");
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.commandAnalysis?.warningLines).toEqual(["Contains inline-eval: python -c"]);
    expect(view.actions[0]?.action).toEqual({
      type: "approval",
      approvalId: "approval-id",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("uses phase-specific keys while preserving exact resolution values", () => {
    const source = APPROVAL_ENGLISH_MESSAGES;
    const candidate = {
      ...source,
      "approval.exec.title.resolved": "تم حسم الموافقة",
      "approval.exec.title.expired": "انتهت صلاحية الموافقة",
    } as const;
    const renderMessage = approvalLocalizationTestHelpers.createRenderer({
      context: createLocalizationContext({
        locale: "ar",
        source: "explicit-recipient",
        audience: "operator",
      }),
      snapshot: createCatalogSnapshot({
        catalogRevision: "approval-test:ar",
        catalogs: { en: source, ar: candidate },
      }),
    });
    const request: ExecApprovalRequest = {
      id: "approval-123",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "cat /srv/مهم/file.txt",
        cwd: "/srv/مهم",
      },
    };

    const resolved = buildResolvedApprovalView(
      request,
      {
        id: request.id,
        decision: "allow-once",
        ts: 3,
        resolvedBy: "operator-7",
      },
      { renderMessage },
    );
    const expired = buildExpiredApprovalView(request, { renderMessage });

    if (resolved.approvalKind !== "exec" || expired.approvalKind !== "exec") {
      throw new Error("expected exec approval views");
    }
    expect(resolved.title).toBe("تم حسم الموافقة");
    expect(resolved.decision).toBe("allow-once");
    expect(resolved.resolvedBy).toBe("operator-7");
    expect(resolved.approvalId).toBe("approval-123");
    expect(resolved.commandText).toBe("cat /srv/مهم/file.txt");
    expect(resolved.cwd).toBe("/srv/مهم");
    expect(expired.title).toBe("انتهت صلاحية الموافقة");
    expect(expired.approvalId).toBe("approval-123");
  });

  it("uses reviewed English as the emergency fallback for missing catalog entries", () => {
    const renderMessage = approvalLocalizationTestHelpers.createRenderer({
      context: createLocalizationContext({
        locale: "ar",
        source: "explicit-recipient",
        audience: "operator",
      }),
      snapshot: createCatalogSnapshot({
        catalogRevision: "approval-test:missing",
        catalogs: { en: {}, ar: {} },
      }),
    });
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: "echo safe" },
    };

    const view = buildPendingApprovalView(request, { renderMessage });

    expect(view.title).toBe("Exec Approval Required");
    expect(view.description).toBe("A command needs your approval.");
    expect(view.actions.map((action) => action.label)).toEqual([
      "Allow Once",
      "Allow Always",
      "Deny",
    ]);
  });

  it("uses one English snapshot for an incomplete safety catalog", () => {
    const renderMessage = approvalLocalizationTestHelpers.createRenderer({
      context: createLocalizationContext({
        locale: "zh-CN",
        source: "explicit-recipient",
        audience: "operator",
      }),
      snapshot: createCatalogSnapshot({
        catalogRevision: "approval-test:partial",
        catalogs: {
          en: {},
          "zh-CN": {
            "approval.exec.title.pending": "需要执行批准",
          },
        },
      }),
    });
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: "echo safe" },
    };

    const view = buildPendingApprovalView(request, { renderMessage });

    expect(view.title).toBe("Exec Approval Required");
    expect(view.description).toBe("A command needs your approval.");
    expect(view.actions.map((action) => action.label)).toEqual([
      "Allow Once",
      "Allow Always",
      "Deny",
    ]);
  });

  it("rejects translator-authored bidi controls in approval catalogs", () => {
    const source = {
      "approval.exec.title.pending": "Exec Approval Required",
    };
    const candidate = {
      "approval.exec.title.pending": "Exec \u202EApproval",
    };

    expect(validateCatalog({ namespace: "approval", source, candidate })).toEqual([
      expect.objectContaining({
        code: "forbidden-bidi-control",
        key: "approval.exec.title.pending",
      }),
    ]);
  });

  it("uses the typed request owner instead of approval id spelling", () => {
    const request: PluginApprovalRequest = {
      id: "custom-id-without-prefix",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Use protected tool",
        description: "The plugin needs operator consent.",
      },
    };

    expect(resolveApprovalRequestKind(request)).toBe("plugin");
    const view = buildPendingApprovalView(request);
    expect(view.approvalKind).toBe("plugin");
    expect(view.actions[0]?.action).toEqual({
      type: "approval",
      approvalId: "custom-id-without-prefix",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  it("keeps the fail-closed plugin decision in channel-facing actions", () => {
    const request: PluginApprovalRequest = {
      id: "plugin-approval",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Use protected tool",
        description: "The plugin needs operator consent.",
        allowedDecisions: ["allow-once"],
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.actions.map((action) => action.action)).toEqual([
      {
        type: "approval",
        approvalId: "plugin-approval",
        approvalKind: "plugin",
        decision: "allow-once",
      },
      {
        type: "approval",
        approvalId: "plugin-approval",
        approvalKind: "plugin",
        decision: "deny",
      },
    ]);
  });

  it.each([
    { request: {} },
    { request: { command: "echo hi", title: "Ambiguous", description: "Ambiguous" } },
  ])("rejects a request payload without exactly one owner: %j", (request) => {
    expect(() => resolveApprovalRequestKind(request)).toThrow("exactly one owner");
  });
});
