import type { ResolvedM365MailAccount } from "./types.js";

/**
 * Security audit findings for the Microsoft 365 email channel.
 *
 * Surfaces an info-level finding when the channel is configured with an open DM
 * policy, since email is an unauthenticated inbound surface and most deployments
 * should gate senders behind an allowlist.
 */
export function collectM365MailSecurityAuditFindings(params: {
  accountId?: string | null;
  account: ResolvedM365MailAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}) {
  if (params.account.dmPolicy !== "open") {
    return [];
  }
  const accountId = params.accountId?.trim() || params.account.accountId || "default";
  const accountNote =
    params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath
      ? ` (account: ${accountId})`
      : "";
  return [
    {
      checkId: "channels.m365mail.dm.open_policy",
      severity: "info" as const,
      title: `Microsoft 365 email dmPolicy is "open"${accountNote}`,
      detail:
        'dmPolicy="open" lets any sender start a conversation with the agent. Email is an unauthenticated inbound surface.',
      remediation:
        'Set dmPolicy="allowlist" and populate allowedSenders with trusted addresses for production deployments.',
    },
  ];
}
