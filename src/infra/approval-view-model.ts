import {
  DEFAULT_APPROVAL_MESSAGE_RENDERER,
  type ApprovalMessageKey,
  type ApprovalMessageRenderer,
} from "./approval-localization.js";
// Builds approval prompt view models from request and resolution events.
import { resolveApprovalRequestKind } from "./approval-types.js";
import type {
  ApprovalMetadataView,
  ApprovalRequest,
  ApprovalResolved,
  ExecApprovalViewBase,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalViewBase,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { buildTypedApprovalActionDescriptors } from "./exec-approval-reply.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
} from "./exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalPhase = "pending" | "resolved" | "expired";

export { resolveApprovalRequestKind } from "./approval-types.js";

type ApprovalViewOptions = {
  // Production callers intentionally preserve English until the recipient
  // locale owner is defined; localization is injected only at this final edge.
  renderMessage?: ApprovalMessageRenderer;
};

function renderApprovalMessage(
  options: ApprovalViewOptions | undefined,
  key: ApprovalMessageKey,
  params?: Parameters<ApprovalMessageRenderer>[1],
): string {
  return (options?.renderMessage ?? DEFAULT_APPROVAL_MESSAGE_RENDERER)(key, params);
}

function buildExecMetadata(
  request: ExecApprovalRequest,
  options?: ApprovalViewOptions,
): ApprovalMetadataView[] {
  const metadata: ApprovalMetadataView[] = [];
  if (request.request.agentId) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.agent"),
      value: request.request.agentId,
    });
  }
  if (request.request.cwd) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.cwd"),
      value: request.request.cwd,
    });
  }
  if (request.request.host) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.host"),
      value: request.request.host,
    });
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.envOverrides"),
      value: request.request.envKeys.join(", "),
    });
  }
  return metadata;
}

function buildPluginMetadata(
  request: PluginApprovalRequest,
  options?: ApprovalViewOptions,
): ApprovalMetadataView[] {
  const metadata: ApprovalMetadataView[] = [];
  const severity = request.request.severity ?? "warning";
  metadata.push({
    label: renderApprovalMessage(options, "approval.metadata.severity"),
    value: renderApprovalMessage(
      options,
      severity === "critical"
        ? "approval.severity.critical"
        : severity === "info"
          ? "approval.severity.info"
          : "approval.severity.warning",
    ),
  });
  if (request.request.toolName) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.tool"),
      value: request.request.toolName,
    });
  }
  if (request.request.pluginId) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.plugin"),
      value: request.request.pluginId,
    });
  }
  if (request.request.agentId) {
    metadata.push({
      label: renderApprovalMessage(options, "approval.metadata.agent"),
      value: request.request.agentId,
    });
  }
  return metadata;
}

function localizeActions<T extends { decision: string; label: string }>(
  actions: readonly T[],
  options?: ApprovalViewOptions,
): T[] {
  return actions.map((action) => ({
    ...action,
    label: renderApprovalMessage(
      options,
      action.decision === "allow-once"
        ? "approval.action.allowOnce"
        : action.decision === "allow-always"
          ? "approval.action.allowAlways"
          : "approval.action.deny",
    ),
  }));
}

function buildExecViewBase<TPhase extends ApprovalPhase>(
  request: ExecApprovalRequest,
  phase: TPhase,
  options?: ApprovalViewOptions,
): ExecApprovalViewBase & { phase: TPhase } {
  const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(request.request);
  return {
    approvalId: request.id,
    approvalKind: "exec",
    phase,
    title: renderApprovalMessage(
      options,
      phase === "pending"
        ? "approval.exec.title.pending"
        : phase === "resolved"
          ? "approval.exec.title.resolved"
          : "approval.exec.title.expired",
    ),
    description:
      phase === "pending"
        ? renderApprovalMessage(options, "approval.exec.description.pending")
        : null,
    metadata: buildExecMetadata(request, options),
    ask: request.request.ask ?? null,
    agentId: request.request.agentId ?? null,
    warningText: request.request.warningText ?? null,
    commandAnalysis: request.request.commandAnalysis ?? null,
    commandText,
    commandPreview,
    cwd: request.request.cwd ?? null,
    envKeys: request.request.envKeys ?? undefined,
    host: request.request.host ?? null,
    nodeId: request.request.nodeId ?? null,
    sessionKey: request.request.sessionKey ?? null,
  };
}

function buildPluginViewBase<TPhase extends ApprovalPhase>(
  request: PluginApprovalRequest,
  phase: TPhase,
  options?: ApprovalViewOptions,
): PluginApprovalViewBase & { phase: TPhase } {
  return {
    approvalId: request.id,
    approvalKind: "plugin",
    phase,
    title: request.request.title,
    description: request.request.description ?? null,
    metadata: buildPluginMetadata(request, options),
    agentId: request.request.agentId ?? null,
    pluginId: request.request.pluginId ?? null,
    toolName: request.request.toolName ?? null,
    severity: request.request.severity ?? "warning",
  };
}

/** Builds the presentation model for an unresolved exec or plugin approval. */
export function buildPendingApprovalView(
  request: ApprovalRequest,
  options?: ApprovalViewOptions,
): PendingApprovalView {
  const approvalKind = resolveApprovalRequestKind(request);
  if (approvalKind === "plugin") {
    const pluginRequest = request as PluginApprovalRequest;
    return {
      ...buildPluginViewBase(pluginRequest, "pending", options),
      actions: localizeActions(
        buildTypedApprovalActionDescriptors({
          approvalCommandId: pluginRequest.id,
          approvalKind,
          allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions(
            pluginRequest.request,
          ),
        }),
        options,
      ),
      expiresAtMs: pluginRequest.expiresAtMs,
    };
  }
  const execRequest = request as ExecApprovalRequest;
  return {
    ...buildExecViewBase(execRequest, "pending", options),
    actions: localizeActions(
      buildTypedApprovalActionDescriptors({
        approvalCommandId: execRequest.id,
        approvalKind,
        ask: execRequest.request.ask,
        allowedDecisions: resolveExecApprovalRequestAllowedDecisions(execRequest.request),
      }),
      options,
    ),
    expiresAtMs: execRequest.expiresAtMs,
  };
}

/** Builds the presentation model for an approval after a decision was recorded. */
export function buildResolvedApprovalView(
  request: ApprovalRequest,
  resolved: ApprovalResolved,
  options?: ApprovalViewOptions,
): ResolvedApprovalView {
  const approvalKind = resolveApprovalRequestKind(request);
  if (approvalKind === "plugin") {
    const pluginRequest = request as PluginApprovalRequest;
    return {
      ...buildPluginViewBase(pluginRequest, "resolved", options),
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
    };
  }
  const execRequest = request as ExecApprovalRequest;
  return {
    ...buildExecViewBase(execRequest, "resolved", options),
    decision: resolved.decision,
    resolvedBy: resolved.resolvedBy,
  };
}

/** Builds the presentation model shown when an approval can no longer be acted on. */
export function buildExpiredApprovalView(
  request: ApprovalRequest,
  options?: ApprovalViewOptions,
): ExpiredApprovalView {
  const approvalKind = resolveApprovalRequestKind(request);
  if (approvalKind === "plugin") {
    return buildPluginViewBase(request as PluginApprovalRequest, "expired", options);
  }
  return buildExecViewBase(request as ExecApprovalRequest, "expired", options);
}
