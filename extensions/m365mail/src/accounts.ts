/**
 * Account resolution: reads config from channels.m365mail, merges per-account
 * overrides, and falls back to environment variables (primarily for the
 * brokered Lobster container, which projects M365MAIL_* env vars at start).
 */

import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { M365MailChannelConfig, ResolvedM365MailAccount } from "./types.js";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_WEBHOOK_PATH = "/webhook/m365mail";
const DEFAULT_RATE_LIMIT = 30;
const CROSS_TENANT_TRUE_VALUES = new Set(["true", "1", "on", "yes"]);

/**
 * Allowlisted Microsoft Graph hosts. `graphBaseUrl` is concatenated into the
 * outbound `fetch()` URL (see graph.ts), so an attacker-controlled value could
 * redirect the agent's reply — and, in non-brokered mode, its Bearer token — to
 * an arbitrary host. Constrain the host to known production Graph endpoints
 * (global and national clouds) and require https; anything else falls back to the
 * default. This is a config-resolution allowlist, not a pre-connect DNS check
 * (graph.ts documents why a DNS-pinned SSRF guard is wrong under transparent
 * egress capture).
 */
const ALLOWED_GRAPH_ORIGINS = new Set([
  "https://graph.microsoft.com",
  "https://graph.microsoft.us",
  "https://dod-graph.microsoft.us",
  "https://microsoftgraph.chinacloudapi.cn",
]);

/**
 * Validate a candidate Graph base URL against {@link ALLOWED_GRAPH_ORIGINS}.
 * Returns the normalized URL when it is https and points at a known Graph host,
 * otherwise `undefined` so the caller can fall back to the default.
 */
function sanitizeGraphBaseUrl(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (
    !ALLOWED_GRAPH_ORIGINS.has(parsed.origin) ||
    path !== "/v1.0" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: OpenClawConfig): M365MailChannelConfig | undefined {
  return cfg?.channels?.["m365mail"] as M365MailChannelConfig | undefined;
}

function resolveImplicitAccountId(channelCfg: M365MailChannelConfig): string | undefined {
  // The brokered container always projects M365MAIL_AUTH, so a default account
  // exists whenever the channel is wired up by Lobster or explicitly enabled.
  return channelCfg.enabled || process.env.M365MAIL_AUTH !== undefined
    ? DEFAULT_ACCOUNT_ID
    : undefined;
}

/** Parse allowedSenders from string or array to a normalized string[]. */
function parseAllowedSenders(raw: string | string[] | undefined): string[] {
  if (!raw) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw.split(",");
  return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function parseRateLimitPerMinute(raw: string | undefined): number {
  if (raw == null) {
    return DEFAULT_RATE_LIMIT;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return DEFAULT_RATE_LIMIT;
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * Resolve cross-tenant sender policy. Defaults to `false` (same-tenant only):
 * an inbound email whose sender tenant differs from — or is absent while — the
 * agent owner's tenant is known is rejected by the webhook handler (fail-closed;
 * see `authorizeSenderTenant`). An explicit `allowCrossTenant: true` (or
 * `M365MAIL_ALLOW_CROSS_TENANT=true`) opts into accepting external senders.
 */
function resolveAllowCrossTenant(field: boolean | undefined): boolean {
  if (typeof field === "boolean") {
    return field;
  }
  const env = process.env.M365MAIL_ALLOW_CROSS_TENANT?.trim().toLowerCase();
  if (env !== undefined && env !== "") {
    return CROSS_TENANT_TRUE_VALUES.has(env);
  }
  return false;
}

/** List all configured account IDs for this channel. */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) {
    return [];
  }
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channelCfg.accounts ?? {}),
    implicitAccountId: resolveImplicitAccountId(channelCfg),
  });
}

/** Resolve a specific account by ID with full defaults applied. */
export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedM365MailAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<Record<string, unknown> & M365MailChannelConfig>({
    channelConfig: channelCfg as Record<string, unknown> & M365MailChannelConfig,
    accounts: channelCfg.accounts as
      | Record<string, Partial<Record<string, unknown> & M365MailChannelConfig>>
      | undefined,
    accountId: id,
  });

  const envGraphBaseUrl = process.env.M365MAIL_GRAPH_BASE_URL?.trim();
  const envWebhookPath = process.env.M365MAIL_WEBHOOK_PATH?.trim();
  const envAllowedSenders = process.env.M365MAIL_ALLOWED_SENDERS ?? "";
  const envRateLimit = parseRateLimitPerMinute(process.env.M365MAIL_RATE_LIMIT);
  const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";
  // The agent's own mailbox id, projected by the Lobster container adapter from
  // the provisioned agent identity (Entra object id, UPN fallback). Used to
  // self-address outbound Graph sends as `/users/{agentId}/…` (see graph.ts).
  const envAgentId = process.env.OPENCLAW_M365MAIL_AGENT_ID?.trim() ?? "";

  // graphBaseUrl is concatenated into the outbound fetch URL, so validate it
  // against the Graph host allowlist; an unrecognized / non-https value falls
  // back to the default rather than being trusted verbatim.
  const graphBaseUrl =
    sanitizeGraphBaseUrl(merged.graphBaseUrl) ??
    sanitizeGraphBaseUrl(envGraphBaseUrl) ??
    DEFAULT_GRAPH_BASE_URL;

  return {
    accountId: id,
    enabled: merged.enabled ?? true,
    brokered: true,
    graphBaseUrl,
    agentId: envAgentId,
    webhookPath: merged.webhookPath || envWebhookPath || DEFAULT_WEBHOOK_PATH,
    dmPolicy: merged.dmPolicy ?? "open",
    allowedSenders: parseAllowedSenders(merged.allowedSenders ?? envAllowedSenders),
    allowCrossTenant: resolveAllowCrossTenant(merged.allowCrossTenant),
    rateLimitPerMinute: merged.rateLimitPerMinute ?? envRateLimit,
    botName: merged.botName ?? envBotName,
  };
}
