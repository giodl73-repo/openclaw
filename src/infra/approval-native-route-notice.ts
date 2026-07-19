// Formats native-route approval notices shown when command approvals leave the current channel.
import { expectDefined } from "@openclaw/normalization-core";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  DEFAULT_APPROVAL_MESSAGE_RENDERER,
  type ApprovalMessageRenderer,
} from "./approval-localization.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";

function formatApprovalDestinationList(
  values: readonly string[],
  renderMessage: ApprovalMessageRenderer,
): string {
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

/** Formats the human destination label for where native approval prompts were delivered. */
export function describeApprovalDeliveryDestination(params: {
  channelLabel: string;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  renderMessage?: ApprovalMessageRenderer;
}): string {
  const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
  const renderMessage = params.renderMessage ?? DEFAULT_APPROVAL_MESSAGE_RENDERER;
  return surfaces.size === 1 && surfaces.has("approver-dm")
    ? renderMessage("approval.route.destination.approverDm", {
        channelLabel: params.channelLabel,
      })
    : params.channelLabel;
}

/** Builds the notice shown in the current chat when approval was routed elsewhere. */
export function resolveApprovalRoutedElsewhereNoticeText(
  destinations: readonly string[],
  renderMessage: ApprovalMessageRenderer = DEFAULT_APPROVAL_MESSAGE_RENDERER,
): string | null {
  const uniqueDestinations = sortUniqueStrings(destinations.map((value) => value.trim())).filter(
    Boolean,
  );
  if (uniqueDestinations.length === 0) {
    return null;
  }
  return renderMessage("approval.route.routedElsewhere", {
    destinations: formatApprovalDestinationList(uniqueDestinations, renderMessage),
  });
}

/** Builds the fallback slash-command notice when native approval delivery fails. */
export function resolveApprovalDeliveryFailedNoticeText(params: {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions?: readonly string[];
  renderMessage?: ApprovalMessageRenderer;
}): string {
  const renderMessage = params.renderMessage ?? DEFAULT_APPROVAL_MESSAGE_RENDERER;
  const commandId =
    params.approvalKind === "exec" && params.approvalId.length > 8
      ? params.approvalId.slice(0, 8)
      : params.approvalId;
  // Exec approval ids are long command ids in chat UX; plugin ids can be short
  // semantic ids, so only shorten exec ids and keep the full-id fallback visible.
  const decisions = (
    params.allowedDecisions?.length
      ? params.allowedDecisions
      : ["allow-once", "allow-always", "deny"]
  ).join("|");
  return [
    renderMessage("approval.route.deliveryFailed"),
    renderMessage("approval.route.replyWith", {
      command: `/approve ${commandId} ${decisions}`,
    }),
    renderMessage("approval.route.ambiguousShortCode"),
  ].join("\n");
}
