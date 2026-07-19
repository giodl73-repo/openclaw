import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approval-id.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type {
  InteractiveReply,
  InteractiveReplyButton,
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationButton,
} from "../interactive/payload.js";
// Builds reply payloads for exec approval prompts and outcomes.
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import { formatApprovalDisplayPath } from "./approval-display-paths.js";
import {
  DEFAULT_APPROVAL_MESSAGE_RENDERER,
  type ApprovalMessageRenderer,
} from "./approval-localization.js";
import {
  describeNativeExecApprovalClientSetup,
  listNativeExecApprovalClientLabels,
  supportsNativeExecApprovalClient,
} from "./exec-approval-surface.js";
import {
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
  type ExecHost,
} from "./exec-approvals.js";

export type ExecApprovalReplyDecision = ExecApprovalDecision;
export type ExecApprovalUnavailableReason =
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported"
  | "no-approval-route";

export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  approvalKind: "exec" | "plugin";
  agentId?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string;
};

export type ExecApprovalActionDescriptor = {
  decision: ExecApprovalReplyDecision;
  label: string;
  style: NonNullable<MessagePresentationButton["style"]>;
  /** Optional semantic action; omitted by the shipped command-backed builders. */
  action?: MessagePresentationAction;
  /** Copyable text fallback retained for non-interactive approval surfaces. */
  command: string;
};

/** Approval descriptor guaranteed to carry a canonical typed approval action. */
export type TypedApprovalActionDescriptor = ExecApprovalActionDescriptor & {
  action: Extract<MessagePresentationAction, { type: "approval" }>;
};

export type ExecApprovalPendingReplyParams = {
  warningText?: string;
  approvalId: string;
  approvalSlug: string;
  approvalCommandId?: string;
  ask?: string | null;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  command: string;
  cwd?: string;
  host: ExecHost;
  nodeId?: string;
  sessionKey?: string | null;
  expiresAtMs?: number;
  nowMs?: number;
};

export type ExecApprovalUnavailableReplyParams = {
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  reason: ExecApprovalUnavailableReason;
  sentApproverDms?: boolean;
  host?: ExecHost;
  nodeId?: string;
};

function formatApprovalHumanList(
  values: readonly string[],
  renderMessage: ApprovalMessageRenderer,
): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return expectDefined(values[0], "values entry at 0");
  }
  if (values.length === 2) {
    return renderMessage("approval.list.two", {
      first: expectDefined(values[0], "values entry at 0"),
      second: expectDefined(values[1], "values entry at 1"),
    });
  }
  const separator = renderMessage("approval.list.separator");
  return renderMessage("approval.list.many", {
    head: values.slice(0, -1).join(separator),
    last: expectDefined(values.at(-1), "values last entry"),
  });
}

function resolveNativeExecApprovalClientList(params: {
  excludeChannel?: string;
  renderMessage: ApprovalMessageRenderer;
}): string {
  return formatApprovalHumanList(
    listNativeExecApprovalClientLabels({
      excludeChannel: params.excludeChannel,
    }),
    params.renderMessage,
  );
}

function buildGenericNativeExecApprovalFallbackText(params?: {
  excludeChannel?: string;
  host?: ExecHost;
  nodeId?: string;
  renderMessage?: ApprovalMessageRenderer;
}): string {
  const renderMessage = params?.renderMessage ?? DEFAULT_APPROVAL_MESSAGE_RENDERER;
  const clients = resolveNativeExecApprovalClientList({
    excludeChannel: params?.excludeChannel,
    renderMessage,
  });
  let manualRecovery = renderMessage("approval.unavailable.manualRecovery");
  if (params?.host === "node") {
    const nodeId = normalizeOptionalString(params.nodeId) ?? "<id|name|ip>";
    manualRecovery += ` ${renderMessage("approval.unavailable.nodePolicyInspection", { nodeId })}`;
  }
  return clients
    ? renderMessage("approval.unavailable.fallback.withClients", { clients, manualRecovery })
    : renderMessage("approval.unavailable.fallback.withoutClients", { manualRecovery });
}

function resolveAllowedDecisions(params: {
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): readonly ExecApprovalReplyDecision[] {
  return params.allowedDecisions ?? resolveExecApprovalAllowedDecisions({ ask: params.ask });
}

function buildApprovalCommandFence(
  descriptors: readonly ExecApprovalActionDescriptor[],
): string | null {
  if (descriptors.length === 0) {
    return null;
  }
  return formatFencedCodeBlock(
    descriptors.map((descriptor) => descriptor.command).join("\n"),
    "txt",
  );
}

export function buildExecApprovalCommandText(params: {
  approvalCommandId: string;
  decision: ExecApprovalReplyDecision;
}): string {
  return `/approve ${params.approvalCommandId} ${params.decision}`;
}

type BuildExecApprovalActionDescriptorsParams = {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

function buildApprovalActionDescriptors(
  approvalCommandId: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
  renderMessage: ApprovalMessageRenderer,
): ExecApprovalActionDescriptor[] {
  const descriptors: ExecApprovalActionDescriptor[] = [];
  const buildDescriptor = (descriptor: {
    decision: ExecApprovalReplyDecision;
    label: string;
    style: ExecApprovalActionDescriptor["style"];
  }): ExecApprovalActionDescriptor => {
    return {
      ...descriptor,
      command: buildExecApprovalCommandText({
        approvalCommandId,
        decision: descriptor.decision,
      }),
    };
  };
  if (allowedDecisions.includes("allow-once")) {
    descriptors.push(
      buildDescriptor({
        decision: "allow-once",
        label: renderMessage("approval.action.allowOnce"),
        style: "success",
      }),
    );
  }
  if (allowedDecisions.includes("allow-always")) {
    descriptors.push(
      buildDescriptor({
        decision: "allow-always",
        label: renderMessage("approval.action.allowAlways"),
        style: "primary",
      }),
    );
  }
  if (allowedDecisions.includes("deny")) {
    descriptors.push(
      buildDescriptor({
        decision: "deny",
        label: renderMessage("approval.action.deny"),
        style: "danger",
      }),
    );
  }
  return descriptors;
}

function buildLocalizedExecApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams,
  renderMessage: ApprovalMessageRenderer,
): ExecApprovalActionDescriptor[] {
  const approvalCommandId = params.approvalCommandId.trim();
  return approvalCommandId
    ? buildApprovalActionDescriptors(
        approvalCommandId,
        resolveAllowedDecisions(params),
        renderMessage,
      )
    : [];
}

export function buildExecApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams,
): ExecApprovalActionDescriptor[] {
  return buildLocalizedExecApprovalActionDescriptors(params, DEFAULT_APPROVAL_MESSAGE_RENDERER);
}

/** Build approval descriptors with explicit owner-aware typed actions. */
export function buildTypedApprovalActionDescriptorsWithRenderer(
  params: BuildExecApprovalActionDescriptorsParams & {
    approvalKind: "exec" | "plugin";
  },
  renderMessage: ApprovalMessageRenderer,
): TypedApprovalActionDescriptor[] {
  const approvalId = params.approvalCommandId;
  if (!isWellFormedApprovalId(approvalId)) {
    return [];
  }
  return buildApprovalActionDescriptors(
    approvalId,
    resolveAllowedDecisions(params),
    renderMessage,
  ).map((descriptor) => {
    return {
      decision: descriptor.decision,
      label: descriptor.label,
      style: descriptor.style,
      command: descriptor.command,
      action: {
        type: "approval",
        approvalId,
        approvalKind: params.approvalKind,
        decision: descriptor.decision,
      },
    };
  });
}

/** Build approval descriptors with explicit owner-aware typed actions. */
export function buildTypedApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams & {
    approvalKind: "exec" | "plugin";
  },
): TypedApprovalActionDescriptor[] {
  return buildTypedApprovalActionDescriptorsWithRenderer(params, DEFAULT_APPROVAL_MESSAGE_RENDERER);
}

function buildApprovalInteractiveButtons(
  descriptors: readonly ExecApprovalActionDescriptor[],
): InteractiveReplyButton[] {
  return descriptors.map((descriptor) => {
    const action =
      descriptor.action ??
      ({ type: "command", command: descriptor.command } satisfies MessagePresentationAction);
    return {
      label: descriptor.label,
      action,
      ...(descriptor.action ? {} : { value: descriptor.command }),
      style: descriptor.style,
    };
  });
}

function buildApprovalPresentationButtons(
  descriptors: readonly ExecApprovalActionDescriptor[],
): MessagePresentationButton[] {
  return descriptors.map((descriptor) => {
    const action =
      descriptor.action ??
      ({ type: "command", command: descriptor.command } satisfies MessagePresentationAction);
    return {
      label: descriptor.label,
      action,
      ...(descriptor.action ? {} : { value: descriptor.command }),
      style: descriptor.style,
    };
  });
}

/** Build portable approval controls from decision descriptors. */
export function buildApprovalPresentationFromActionDescriptors(
  actions: readonly ExecApprovalActionDescriptor[],
): MessagePresentation | undefined {
  const buttons = buildApprovalPresentationButtons(actions);
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

type BuildApprovalPresentationParams = {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

function buildLocalizedApprovalPresentation(
  params: BuildApprovalPresentationParams,
  renderMessage: ApprovalMessageRenderer,
): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(
    buildLocalizedExecApprovalActionDescriptors(
      {
        approvalCommandId: params.approvalId,
        ask: params.ask,
        allowedDecisions: params.allowedDecisions,
      },
      renderMessage,
    ),
  );
}

/** Build the shipped command-backed portable approval controls. */
export function buildApprovalPresentation(
  params: BuildApprovalPresentationParams,
): MessagePresentation | undefined {
  return buildLocalizedApprovalPresentation(params, DEFAULT_APPROVAL_MESSAGE_RENDERER);
}

/** Build portable approval controls with explicit owner-aware typed actions. */
function buildLocalizedTypedApprovalPresentation(
  params: BuildApprovalPresentationParams & { approvalKind: "exec" | "plugin" },
  renderMessage: ApprovalMessageRenderer,
): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(
    buildTypedApprovalActionDescriptorsWithRenderer(
      {
        approvalCommandId: params.approvalId,
        approvalKind: params.approvalKind,
        ask: params.ask,
        allowedDecisions: params.allowedDecisions,
      },
      renderMessage,
    ),
  );
}

/** Build portable approval controls with explicit owner-aware typed actions. */
export function buildTypedApprovalPresentation(
  params: BuildApprovalPresentationParams & { approvalKind: "exec" | "plugin" },
): MessagePresentation | undefined {
  return buildLocalizedTypedApprovalPresentation(params, DEFAULT_APPROVAL_MESSAGE_RENDERER);
}

/** Build the shipped command-backed exec-approval presentation. */
export function buildExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined {
  return buildApprovalPresentation({
    approvalId: params.approvalCommandId,
    ask: params.ask,
    allowedDecisions: params.allowedDecisions,
  });
}

/** Build an exec-approval presentation with canonical typed decision actions. */
export function buildTypedExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined {
  return buildTypedApprovalPresentation({
    approvalId: params.approvalCommandId,
    approvalKind: "exec",
    ask: params.ask,
    allowedDecisions: params.allowedDecisions,
  });
}

/**
 * @deprecated Use buildApprovalPresentationFromActionDescriptors.
 */
export function buildApprovalInteractiveReplyFromActionDescriptors(
  actions: readonly ExecApprovalActionDescriptor[],
): InteractiveReply | undefined {
  const buttons = buildApprovalInteractiveButtons(actions);
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

function getLocalizedExecApprovalApproverDmNoticeText(
  renderMessage: ApprovalMessageRenderer,
): string {
  return renderMessage("approval.unavailable.dmSent");
}

export function getExecApprovalApproverDmNoticeText(): string {
  return getLocalizedExecApprovalApproverDmNoticeText(DEFAULT_APPROVAL_MESSAGE_RENDERER);
}

export function parseExecApprovalCommandText(
  raw: string,
): { approvalId: string; decision: ExecApprovalReplyDecision } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(
    /^\/?approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  const rawDecision = normalizeOptionalLowercaseString(match[2]) ?? "";
  return {
    approvalId: expectDefined(match[1], "exec approval reply regex capture 1"),
    decision:
      rawDecision === "always" ? "allow-always" : (rawDecision as ExecApprovalReplyDecision),
  };
}

function formatLocalizedExecApprovalExpiresIn(
  expiresAtMs: number,
  nowMs: number,
  renderMessage: ApprovalMessageRenderer,
): string {
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 60) {
    return renderMessage("approval.duration.seconds", { value: totalSeconds });
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(renderMessage("approval.duration.hours", { value: hours }));
  }
  if (minutes > 0) {
    parts.push(renderMessage("approval.duration.minutes", { value: minutes }));
  }
  if (hours === 0 && minutes < 5 && seconds > 0) {
    parts.push(renderMessage("approval.duration.seconds", { value: seconds }));
  }
  return parts.join(" ");
}

export function formatExecApprovalExpiresIn(expiresAtMs: number, nowMs: number): string {
  return formatLocalizedExecApprovalExpiresIn(
    expiresAtMs,
    nowMs,
    DEFAULT_APPROVAL_MESSAGE_RENDERER,
  );
}

export function getExecApprovalReplyMetadata(
  payload: ReplyPayload,
): ExecApprovalReplyMetadata | null {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return null;
  }
  const execApproval = channelData.execApproval;
  if (!execApproval || typeof execApproval !== "object" || Array.isArray(execApproval)) {
    return null;
  }
  const record = execApproval as Record<string, unknown>;
  const approvalId = normalizeOptionalString(record.approvalId) ?? "";
  const approvalSlug = normalizeOptionalString(record.approvalSlug) ?? "";
  if (!approvalId || !approvalSlug) {
    return null;
  }
  const approvalKind = record.approvalKind === "plugin" ? "plugin" : "exec";
  const allowedDecisions = Array.isArray(record.allowedDecisions)
    ? record.allowedDecisions.filter(
        (value): value is ExecApprovalReplyDecision =>
          value === "allow-once" || value === "allow-always" || value === "deny",
      )
    : undefined;
  const agentId = normalizeOptionalString(record.agentId);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  return {
    approvalId,
    approvalSlug,
    approvalKind,
    agentId,
    allowedDecisions,
    sessionKey,
  };
}

export function buildExecApprovalPendingReplyPayloadWithRenderer(
  params: ExecApprovalPendingReplyParams,
  renderMessage: ApprovalMessageRenderer,
): ReplyPayload {
  const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
  const allowedDecisions = resolveAllowedDecisions(params);
  const descriptors = buildLocalizedExecApprovalActionDescriptors(
    {
      approvalCommandId,
      allowedDecisions,
    },
    renderMessage,
  );
  const primaryAction = descriptors[0] ?? null;
  const secondaryActions = descriptors.slice(1);
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }
  lines.push(renderMessage("approval.reply.required"));
  if (primaryAction) {
    lines.push(renderMessage("approval.reply.run"));
    lines.push(formatFencedCodeBlock(primaryAction.command, "txt"));
  }
  lines.push(renderMessage("approval.reply.pendingCommand"));
  lines.push(formatFencedCodeBlock(params.command, "sh"));
  const secondaryFence = buildApprovalCommandFence(secondaryActions);
  if (secondaryFence) {
    lines.push(renderMessage("approval.reply.otherOptions"));
    lines.push(secondaryFence);
  }
  if (!allowedDecisions.includes("allow-always")) {
    lines.push(renderMessage("approval.reply.allowAlwaysUnavailable"));
  }
  const info: string[] = [];
  info.push(renderMessage("approval.reply.info.host", { host: params.host }));
  if (params.nodeId) {
    info.push(renderMessage("approval.reply.info.node", { nodeId: params.nodeId }));
  }
  if (params.cwd) {
    info.push(
      renderMessage("approval.reply.info.cwd", {
        cwd: formatApprovalDisplayPath(params.cwd),
      }),
    );
  }
  if (typeof params.expiresAtMs === "number" && Number.isFinite(params.expiresAtMs)) {
    info.push(
      renderMessage("approval.reply.info.expiresIn", {
        duration: formatLocalizedExecApprovalExpiresIn(
          params.expiresAtMs,
          params.nowMs ?? Date.now(),
          renderMessage,
        ),
      }),
    );
  }
  info.push(renderMessage("approval.reply.info.fullId", { approvalId: params.approvalId }));
  lines.push(info.join("\n"));

  return {
    text: lines.join("\n\n"),
    presentation: buildLocalizedApprovalPresentation(
      {
        approvalId: params.approvalId,
        allowedDecisions,
      },
      renderMessage,
    ),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        approvalKind: "exec",
        agentId: normalizeOptionalString(params.agentId),
        allowedDecisions,
        sessionKey: normalizeOptionalString(params.sessionKey),
      },
    },
  };
}

export function buildExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  return buildExecApprovalPendingReplyPayloadWithRenderer(
    params,
    DEFAULT_APPROVAL_MESSAGE_RENDERER,
  );
}

/** Build an exec approval prompt with canonical typed decision actions. */
export function buildTypedExecApprovalPendingReplyPayloadWithRenderer(
  params: ExecApprovalPendingReplyParams,
  renderMessage: ApprovalMessageRenderer,
): ReplyPayload {
  const payload = buildExecApprovalPendingReplyPayloadWithRenderer(params, renderMessage);
  return {
    ...payload,
    presentation: buildLocalizedTypedApprovalPresentation(
      {
        approvalId: params.approvalId,
        approvalKind: "exec",
        allowedDecisions: resolveAllowedDecisions(params),
      },
      renderMessage,
    ),
  };
}

/** Build an exec approval prompt with canonical typed decision actions. */
export function buildTypedExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  return buildTypedExecApprovalPendingReplyPayloadWithRenderer(
    params,
    DEFAULT_APPROVAL_MESSAGE_RENDERER,
  );
}

export function buildExecApprovalUnavailableReplyPayloadWithRenderer(
  params: ExecApprovalUnavailableReplyParams,
  requestedRenderer: ApprovalMessageRenderer,
): ReplyPayload {
  let renderMessage = requestedRenderer;
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }

  if (params.sentApproverDms) {
    lines.push(getLocalizedExecApprovalApproverDmNoticeText(renderMessage));
    return {
      text: lines.join("\n\n"),
    };
  }

  if (params.reason === "initiating-platform-disabled") {
    const channel = normalizeOptionalLowercaseString(params.channel);
    const setupText =
      channel && params.channelLabel && supportsNativeExecApprovalClient(channel)
        ? describeNativeExecApprovalClientSetup({
            channel,
            channelLabel: params.channelLabel,
            accountId: params.accountId,
          })
        : null;
    if (setupText) {
      // Channel-owned setup paragraphs remain English until their adapters own translations.
      renderMessage = DEFAULT_APPROVAL_MESSAGE_RENDERER;
      lines.push(
        renderMessage("approval.unavailable.disabled", {
          channelLabel: params.channelLabel ?? renderMessage("approval.unavailable.platform.this"),
        }),
      );
      lines.push(setupText);
    } else {
      lines.push(
        renderMessage("approval.unavailable.disabled", {
          channelLabel: params.channelLabel ?? renderMessage("approval.unavailable.platform.this"),
        }),
      );
      lines.push(
        buildGenericNativeExecApprovalFallbackText({
          host: params.host,
          nodeId: params.nodeId,
          renderMessage,
        }),
      );
    }
  } else if (params.reason === "initiating-platform-unsupported") {
    lines.push(
      renderMessage("approval.unavailable.unsupported", {
        channelLabel: params.channelLabel ?? renderMessage("approval.unavailable.platform.this"),
      }),
    );
    lines.push(
      buildGenericNativeExecApprovalFallbackText({
        excludeChannel: params.channel,
        host: params.host,
        nodeId: params.nodeId,
        renderMessage,
      }),
    );
  } else {
    lines.push(renderMessage("approval.unavailable.noRoute"));
    const fallback = buildGenericNativeExecApprovalFallbackText({
      host: params.host,
      nodeId: params.nodeId,
      renderMessage,
    });
    lines.push(
      renderMessage("approval.unavailable.noRouteRecovery", {
        fallback,
      }),
    );
  }

  return {
    text: lines.join("\n\n"),
  };
}

export function buildExecApprovalUnavailableReplyPayload(
  params: ExecApprovalUnavailableReplyParams,
): ReplyPayload {
  return buildExecApprovalUnavailableReplyPayloadWithRenderer(
    params,
    DEFAULT_APPROVAL_MESSAGE_RENDERER,
  );
}
