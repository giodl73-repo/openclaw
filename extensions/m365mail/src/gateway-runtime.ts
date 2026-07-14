import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveAccount } from "./accounts.js";
import { dispatchM365MailInboundTurn } from "./inbound-turn.js";
import type { ResolvedM365MailAccount } from "./types.js";
import { createWebhookHandler, type WebhookHandlerDeps } from "./webhook-handler.js";

const CHANNEL_ID = "m365mail";

type M365MailGatewayLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type M365MailGatewayStartupIssueCode = "disabled" | "empty-allowlist" | "identity-missing";
type M365MailGatewayStartupIssue = {
  code: M365MailGatewayStartupIssueCode;
  logLevel: "info" | "warn";
  message: string;
};

const activeRoutes = new Map<string, { accountId: string; unregister: () => void }>();

function buildStartupIssue(
  code: M365MailGatewayStartupIssueCode,
  message: string,
  logLevel: "info" | "warn" = "warn",
): M365MailGatewayStartupIssue {
  return { code, logLevel, message };
}

function logStartupIssues(
  log: M365MailGatewayLog | undefined,
  issues: M365MailGatewayStartupIssue[],
) {
  for (const issue of issues) {
    const message = `Microsoft 365 Email ${issue.message}`;
    if (issue.logLevel === "info") {
      log?.info?.(message);
      continue;
    }
    log?.warn?.(message);
  }
}

function createUnknownArgsLogAdapter(
  log?: M365MailGatewayLog,
): WebhookHandlerDeps["log"] | undefined {
  if (!log) {
    return undefined;
  }
  const formatArg = (value: unknown): string =>
    typeof value === "string" ? value : value instanceof Error ? value.message : "";
  return {
    info: (...args) => log.info?.(formatArg(args[0])),
    warn: (...args) => log.warn?.(formatArg(args[0])),
    error: (...args) => log.error?.(formatArg(args[0])),
  };
}

export function collectM365MailGatewayStartupIssues(params: {
  cfg: OpenClawConfig;
  account: ResolvedM365MailAccount;
  accountId: string;
}): M365MailGatewayStartupIssue[] {
  const { account, accountId } = params;
  const issues: M365MailGatewayStartupIssue[] = [];

  if (!account.enabled) {
    issues.push(
      buildStartupIssue("disabled", `account ${accountId} is disabled, skipping`, "info"),
    );
    return issues;
  }
  if (account.dmPolicy === "allowlist" && account.allowedSenders.length === 0) {
    issues.push(
      buildStartupIssue(
        "empty-allowlist",
        `account ${accountId} has dmPolicy=allowlist but empty allowedSenders; refusing to start route`,
      ),
    );
  }
  if (!account.agentId) {
    issues.push(
      buildStartupIssue(
        "identity-missing",
        `account ${accountId} has no trusted mailbox identity; refusing to start route`,
      ),
    );
  }

  return issues;
}

export function collectM365MailGatewayRoutingWarnings(params: {
  cfg: OpenClawConfig;
  account: ResolvedM365MailAccount;
}): string[] {
  return collectM365MailGatewayStartupIssues({
    cfg: params.cfg,
    account: params.account,
    accountId: params.account.accountId,
  })
    .filter((issue) => issue.code === "empty-allowlist")
    .map((issue) => `- Microsoft 365 Email: ${issue.message}`);
}

export function validateM365MailGatewayAccountStartup(params: {
  cfg: OpenClawConfig;
  account: ResolvedM365MailAccount;
  accountId: string;
  log?: M365MailGatewayLog;
}): { ok: true } | { ok: false } {
  const issues = collectM365MailGatewayStartupIssues(params);
  if (issues.length > 0) {
    logStartupIssues(params.log, issues);
    return { ok: false };
  }
  return { ok: true };
}

export function registerM365MailWebhookRoute(params: {
  account: ResolvedM365MailAccount;
  accountId: string;
  log?: M365MailGatewayLog;
}): () => void {
  const { account, accountId, log } = params;
  const routeKey = account.webhookPath;
  const activeRoute = activeRoutes.get(routeKey);
  if (activeRoute && activeRoute.accountId !== accountId) {
    throw new Error(
      `Microsoft 365 Email webhook path ${routeKey} is already registered by account ${activeRoute.accountId}`,
    );
  }
  if (activeRoute) {
    log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
    activeRoute.unregister();
    activeRoutes.delete(routeKey);
  }

  const handler = createWebhookHandler({
    account,
    deliver: async (msg) =>
      await dispatchM365MailInboundTurn({
        account,
        msg,
        log: createUnknownArgsLogAdapter(log),
      }),
    log: createUnknownArgsLogAdapter(log),
  });
  const unregister = registerPluginHttpRoute({
    path: account.webhookPath,
    auth: "gateway",
    pluginId: CHANNEL_ID,
    accountId: account.accountId,
    log: (msg: string) => log?.info?.(msg),
    handler,
  });
  activeRoutes.set(routeKey, { accountId, unregister });
  return () => {
    unregister();
    if (activeRoutes.get(routeKey)?.unregister === unregister) {
      activeRoutes.delete(routeKey);
    }
  };
}

export { resolveAccount };
