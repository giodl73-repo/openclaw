import {
  createCatalogSnapshot,
  createLocalizationContext,
  renderLocalizedMessage,
  resolveLocalizationContext,
  validateCatalog,
  type CatalogSnapshot,
  type LocalizationContext,
  type MessageParam,
} from "@openclaw/localization-core";

export const APPROVAL_ENGLISH_MESSAGES = Object.freeze({
  "approval.exec.title.pending": "Exec Approval Required",
  "approval.exec.title.resolved": "Exec Approval",
  "approval.exec.title.expired": "Exec Approval",
  "approval.exec.description.pending": "A command needs your approval.",
  "approval.metadata.agent": "Agent",
  "approval.metadata.cwd": "CWD",
  "approval.metadata.host": "Host",
  "approval.metadata.envOverrides": "Env Overrides",
  "approval.metadata.severity": "Severity",
  "approval.metadata.tool": "Tool",
  "approval.metadata.plugin": "Plugin",
  "approval.severity.critical": "Critical",
  "approval.severity.info": "Info",
  "approval.severity.warning": "Warning",
  "approval.action.allowOnce": "Allow Once",
  "approval.action.allowAlways": "Allow Always",
  "approval.action.deny": "Deny",
  "approval.reply.required": "Approval required.",
  "approval.reply.run": "Run:",
  "approval.reply.pendingCommand": "Pending command:",
  "approval.reply.otherOptions": "Other options:",
  "approval.reply.allowAlwaysUnavailable": "Allow Always is unavailable for this command.",
  "approval.reply.info.host": "Host: {host}",
  "approval.reply.info.node": "Node: {nodeId}",
  "approval.reply.info.cwd": "CWD: {cwd}",
  "approval.reply.info.expiresIn": "Expires in: {duration}",
  "approval.reply.info.fullId": "Full id: `{approvalId}`",
  "approval.duration.hours": "{value}h",
  "approval.duration.minutes": "{value}m",
  "approval.duration.seconds": "{value}s",
  "approval.list.separator": ", ",
  "approval.list.two": "{first} or {second}",
  "approval.list.many": "{head}, or {last}",
  "approval.unavailable.platform.this": "this platform",
  "approval.unavailable.dmSent":
    "Approval required. I sent approval DMs to the approvers for this account.",
  "approval.unavailable.disabled":
    "Exec approval is required, but native chat exec approvals are not configured on {channelLabel}.",
  "approval.unavailable.unsupported":
    "Exec approval is required, but {channelLabel} does not support chat exec approvals.",
  "approval.unavailable.noRoute":
    "Exec approval is required, but no interactive approval client is currently available.",
  "approval.unavailable.manualRecovery":
    "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
  "approval.unavailable.nodePolicyInspection":
    "Inspect the node's effective exec policy with `openclaw approvals get --node {nodeId}`.",
  "approval.unavailable.fallback.withClients":
    "Approve it from the Web UI or terminal UI, or enable a native chat approval client such as {clients}. {manualRecovery} If those accounts already know your owner ID via allowFrom or owner config, OpenClaw can often infer approvers automatically.",
  "approval.unavailable.fallback.withoutClients":
    "Approve it from the Web UI or terminal UI. {manualRecovery}",
  "approval.unavailable.noRouteRecovery":
    "{fallback} Then retry the command. You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.",
  "approval.route.destination.approverDm": "{channelLabel} DMs",
  "approval.route.routedElsewhere":
    "Approval required. I sent the approval request to {destinations}, not this chat.",
  "approval.route.deliveryFailed":
    "Approval required. I could not deliver the native approval request.",
  "approval.route.replyWith": "Reply with: {command}",
  "approval.route.ambiguousShortCode":
    "If the short code is ambiguous, use the full id in /approve.",
} as const);

export const APPROVAL_ZH_CN_MESSAGES = Object.freeze({
  "approval.exec.title.pending": "需要执行批准",
  "approval.exec.title.resolved": "执行批准",
  "approval.exec.title.expired": "执行批准",
  "approval.exec.description.pending": "一个命令需要你的批准。",
  "approval.metadata.agent": "代理",
  "approval.metadata.cwd": "工作目录",
  "approval.metadata.host": "主机",
  "approval.metadata.envOverrides": "环境变量覆盖",
  "approval.metadata.severity": "严重性",
  "approval.metadata.tool": "工具",
  "approval.metadata.plugin": "插件",
  "approval.severity.critical": "严重",
  "approval.severity.info": "信息",
  "approval.severity.warning": "警告",
  "approval.action.allowOnce": "允许一次",
  "approval.action.allowAlways": "始终允许",
  "approval.action.deny": "拒绝",
  "approval.reply.required": "需要批准。",
  "approval.reply.run": "执行：",
  "approval.reply.pendingCommand": "待执行命令：",
  "approval.reply.otherOptions": "其他选项：",
  "approval.reply.allowAlwaysUnavailable": "此命令无法使用“始终允许”。",
  "approval.reply.info.host": "主机：{host}",
  "approval.reply.info.node": "节点：{nodeId}",
  "approval.reply.info.cwd": "工作目录：{cwd}",
  "approval.reply.info.expiresIn": "剩余有效时间：{duration}",
  "approval.reply.info.fullId": "完整 ID：`{approvalId}`",
  "approval.duration.hours": "{value} 小时",
  "approval.duration.minutes": "{value} 分钟",
  "approval.duration.seconds": "{value} 秒",
  "approval.list.separator": "、",
  "approval.list.two": "{first}或{second}",
  "approval.list.many": "{head}或{last}",
  "approval.unavailable.platform.this": "当前平台",
  "approval.unavailable.dmSent": "需要批准。我已向此帐户的批准者发送批准私信。",
  "approval.unavailable.disabled": "需要执行批准，但尚未在{channelLabel}上配置原生聊天执行批准。",
  "approval.unavailable.unsupported": "需要执行批准，但{channelLabel}不支持聊天执行批准。",
  "approval.unavailable.noRoute": "需要执行批准，但当前没有可用的交互式批准客户端。",
  "approval.unavailable.manualRecovery":
    "使用 `openclaw dashboard --no-open` 输出控制界面 URL，在浏览器中打开该 URL，然后使用批准收件箱。",
  "approval.unavailable.nodePolicyInspection":
    "使用 `openclaw approvals get --node {nodeId}` 检查该节点的有效执行策略。",
  "approval.unavailable.fallback.withClients":
    "可从 Web UI 或终端 UI 批准，或启用原生聊天批准客户端，例如{clients}。{manualRecovery} 如果这些帐户已通过 allowFrom 或所有者配置知道你的所有者 ID，OpenClaw 通常可以自动推断批准者。",
  "approval.unavailable.fallback.withoutClients": "可从 Web UI 或终端 UI 批准。{manualRecovery}",
  "approval.unavailable.noRouteRecovery":
    "{fallback} 然后重试该命令。只要所有者配置已识别批准者，通常可以不设置 execApprovals.approvers。",
  "approval.route.destination.approverDm": "{channelLabel} 私信",
  "approval.route.routedElsewhere": "需要批准。我已将批准请求发送到{destinations}，而不是此聊天。",
  "approval.route.deliveryFailed": "需要批准。我无法发送原生批准请求。",
  "approval.route.replyWith": "请回复：{command}",
  "approval.route.ambiguousShortCode": "如果短代码有歧义，请在 /approve 中使用完整 ID。",
} satisfies Readonly<Record<keyof typeof APPROVAL_ENGLISH_MESSAGES, string>>);

export type ApprovalMessageKey = keyof typeof APPROVAL_ENGLISH_MESSAGES;
export type ApprovalMessageRenderer = ((
  key: ApprovalMessageKey,
  params?: Readonly<Record<string, MessageParam>>,
) => string) & {
  readonly context: LocalizationContext;
};

const APPROVAL_ENGLISH_CATALOG_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "approval-runtime:2",
  catalogs: {
    en: APPROVAL_ENGLISH_MESSAGES,
  },
});

// Non-English approval safety copy remains validation-only until owner and SecOps attestation.
const APPROVAL_TRANSLATION_CATALOG_SNAPSHOT = createCatalogSnapshot({
  catalogRevision: "approval-runtime:2",
  catalogs: {
    en: APPROVAL_ENGLISH_MESSAGES,
    "zh-CN": APPROVAL_ZH_CN_MESSAGES,
  },
});

function hasCompleteApprovalCatalog(snapshot: CatalogSnapshot, context: LocalizationContext) {
  if (context.locale === "en") {
    return true;
  }
  const candidate = snapshot.catalogs[context.locale];
  return (
    candidate !== undefined &&
    validateCatalog({
      namespace: "approval",
      source: APPROVAL_ENGLISH_MESSAGES,
      candidate,
    }).length === 0
  );
}

function createApprovalMessageRendererInternal(options?: {
  recipientLocale?: string | null;
  context?: LocalizationContext;
  snapshot?: CatalogSnapshot;
}): ApprovalMessageRenderer {
  const requestedContext =
    options?.context ??
    resolveLocalizationContext({
      audience: "user",
      explicitRecipient: options?.recipientLocale,
      supportedLocales: ["en", "zh-CN"],
    }).context;
  const context = Object.freeze({
    ...requestedContext,
    fallbackLocales: Object.freeze([...requestedContext.fallbackLocales]),
  });
  const requestedSnapshot = options?.snapshot ?? APPROVAL_ENGLISH_CATALOG_SNAPSHOT;
  const hasCompleteCatalog = hasCompleteApprovalCatalog(requestedSnapshot, context);
  const renderContext = hasCompleteCatalog
    ? context
    : createLocalizationContext({
        locale: "en",
        source: "english-default",
        audience: "user",
      });
  const renderSnapshot = hasCompleteCatalog ? requestedSnapshot : APPROVAL_ENGLISH_CATALOG_SNAPSHOT;
  const renderer = ((key: ApprovalMessageKey, params?: Readonly<Record<string, MessageParam>>) =>
    renderLocalizedMessage(renderSnapshot, renderContext, {
      key,
      params,
      fallback: APPROVAL_ENGLISH_MESSAGES[key],
    })) as ApprovalMessageRenderer;
  Object.defineProperty(renderer, "context", {
    value: renderContext,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(renderer);
}

/** Creates the final-boundary renderer used by the core approval message family. */
export function createApprovalMessageRenderer(options?: {
  recipientLocale?: string | null;
}): ApprovalMessageRenderer {
  return createApprovalMessageRendererInternal(options);
}

export const approvalLocalizationTestHelpers = Object.freeze({
  createRenderer(options?: {
    recipientLocale?: string | null;
    context?: LocalizationContext;
    snapshot?: CatalogSnapshot;
  }): ApprovalMessageRenderer {
    return createApprovalMessageRendererInternal({
      snapshot: APPROVAL_TRANSLATION_CATALOG_SNAPSHOT,
      ...options,
    });
  },
});

export const DEFAULT_APPROVAL_MESSAGE_RENDERER = createApprovalMessageRenderer();
