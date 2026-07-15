/**
 * Inbound webhook handler for Microsoft 365 email activities.
 *
 * The external host runtime forwards the raw Bot Framework Activity it receives on the
 * shared ACF / Agent 365 `bot-activities` callback VERBATIM to this loopback
 * route — the Activity is the contract (same payload the msteams native path
 * gets). Trust is established by the loopback binding + the runtime's own AAD
 * validation of the upstream callback, so there is no webhook token to check.
 * The handler parses the email out of the activity, authorizes the sender
 * against the DM policy, ACKs immediately, then dispatches the turn
 * asynchronously (the dispatcher sends the reply via Microsoft Graph).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createPersistentDedupeCache,
  type PersistentDedupeCache,
} from "openclaw/plugin-sdk/dedupe-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { M365MailInboundMessage } from "./inbound-context.js";
import { getOptionalM365MailRuntime } from "./runtime.js";
import {
  authorizeSenderForDm,
  authorizeSenderTenant,
  maskSender,
  RateLimiter,
  sanitizeInput,
} from "./security.js";
import type {
  BotFrameworkActivity,
  EmailNotificationEntity,
  ResolvedM365MailAccount,
} from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const AGENT_RESPONSE_TIMEOUT_MS = 180_000;
const MESSAGE_DEDUPE_TTL_MS = 24 * 60 * 60_000;
const MESSAGE_DEDUPE_MAX_SIZE = 10_000;
const MESSAGE_DEDUPE_PERSISTENT_MAX_SIZE = 10_000;

const rateLimiters = new Map<string, RateLimiter>();
type DeliveredMessageRecord = { deliveredAt: number };
const deliveredMessagesByAccount = new Map<string, PersistentDedupeCache<DeliveredMessageRecord>>();
const pendingDeliveriesByAccount = new Map<string, Map<string, Promise<boolean>>>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();

function reservePendingDelivery(
  accountId: string,
  messageId: string,
):
  | { leader: false; completion: Promise<boolean> }
  | { leader: true; complete: (committed: boolean) => void } {
  let pendingDeliveries = pendingDeliveriesByAccount.get(accountId);
  if (!pendingDeliveries) {
    pendingDeliveries = new Map();
    pendingDeliveriesByAccount.set(accountId, pendingDeliveries);
  }
  const existing = pendingDeliveries.get(messageId);
  if (existing) {
    return { leader: false, completion: existing };
  }

  let resolveCompletion: (committed: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve;
  });
  pendingDeliveries.set(messageId, completion);
  return {
    leader: true,
    complete: (committed) => {
      pendingDeliveries.delete(messageId);
      if (pendingDeliveries.size === 0) {
        pendingDeliveriesByAccount.delete(accountId);
      }
      resolveCompletion(committed);
    },
  };
}

function getDeliveredMessages(accountId: string) {
  let dedupe = deliveredMessagesByAccount.get(accountId);
  if (!dedupe) {
    const namespaceAccountId = encodeURIComponent(accountId);
    dedupe = createPersistentDedupeCache<DeliveredMessageRecord>({
      globalKey: Symbol.for(`openclaw.m365mailInboundDeliveries.${namespaceAccountId}`),
      ttlMs: MESSAGE_DEDUPE_TTL_MS,
      maxSize: MESSAGE_DEDUPE_MAX_SIZE,
      persistent: {
        namespace: `m365mail.inbound-deliveries.${namespaceAccountId}`,
        maxEntries: MESSAGE_DEDUPE_PERSISTENT_MAX_SIZE,
        openStore: (options) => getOptionalM365MailRuntime()?.state.openKeyedStore(options),
        logError: (error) => {
          getOptionalM365MailRuntime()
            ?.logging.getChildLogger({ plugin: "m365mail", feature: "inbound-dedupe" })
            .warn("Microsoft 365 Email persistent inbound dedupe failed", {
              error: String(error),
            });
        },
        readTimestamp: (record) => record.deliveredAt,
      },
    });
    deliveredMessagesByAccount.set(accountId, dedupe);
  }
  return dedupe;
}

function getRateLimiter(account: ResolvedM365MailAccount): RateLimiter {
  let rl = rateLimiters.get(account.accountId);
  if (!rl || rl.maxRequests() !== account.rateLimitPerMinute) {
    rl?.clear();
    rl = new RateLimiter(account.rateLimitPerMinute);
    rateLimiters.set(account.accountId, rl);
  }
  return rl;
}

export function clearM365MailWebhookRateLimiterStateForTest(): void {
  for (const limiter of rateLimiters.values()) {
    limiter.clear();
  }
  rateLimiters.clear();
  for (const dedupe of deliveredMessagesByAccount.values()) {
    dedupe.clearForTest();
  }
  deliveredMessagesByAccount.clear();
  pendingDeliveriesByAccount.clear();
  webhookInFlightLimiter.clear();
}

/** Strip HTML tags to a readable plain-text approximation. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Find the `emailNotification` entity carrying the body + ids, if present. */
function findEmailEntity(activity: BotFrameworkActivity): EmailNotificationEntity | undefined {
  const entities = Array.isArray(activity.entities) ? activity.entities : [];
  const found = entities.find(
    (e) => Boolean(e) && typeof e === "object" && e.type === "emailNotification",
  );
  if (!found) {
    return undefined;
  }
  return {
    type: "emailNotification",
    id: typeof found.id === "string" ? found.id : undefined,
    conversationId: typeof found.conversationId === "string" ? found.conversationId : undefined,
    htmlBody: typeof found.htmlBody === "string" ? found.htmlBody : undefined,
  };
}

/** Resolve the email conversation/thread id (session peer). */
function resolveConversationId(
  activity: BotFrameworkActivity,
  emailEntity: EmailNotificationEntity | undefined,
): string {
  return emailEntity?.conversationId?.trim() || activity.conversation?.id?.trim() || "";
}

function extractBodyText(
  activity: BotFrameworkActivity,
  emailEntity: EmailNotificationEntity | undefined,
): string {
  const html = emailEntity?.htmlBody;
  if (html && html.trim()) {
    return htmlToText(html);
  }
  if (activity.text && activity.text.trim()) {
    return activity.text;
  }
  return "";
}

type ParsedActivity = { ok: true; activity: BotFrameworkActivity } | { ok: false };

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: string } | { ok: false; statusCode: number; error: string }> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: MAX_BODY_BYTES,
      timeoutMs: BODY_TIMEOUT_MS,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return { ok: false, statusCode: err.statusCode, error: requestBodyErrorToText(err.code) };
    }
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function parseActivity(body: string): ParsedActivity {
  if (!body.trim()) {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, activity: parsed as BotFrameworkActivity };
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondAccepted(res: ServerResponse) {
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "accepted" }));
}

export interface WebhookHandlerDeps {
  account: ResolvedM365MailAccount;
  deliver: (msg: M365MailInboundMessage) => Promise<null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

function resolveInboundAgentIdentityAssertion(
  account: ResolvedM365MailAccount,
  activity: BotFrameworkActivity,
): string | undefined {
  const agenticUserId = activity.recipient?.agenticUserId?.trim();
  const recipientId = activity.recipient?.id?.trim();
  if (account.agentId && (agenticUserId === account.agentId || recipientId === account.agentId)) {
    return account.agentId;
  }
  return agenticUserId || recipientId || undefined;
}

function matchesInboundAgentIdentity(
  account: ResolvedM365MailAccount,
  activity: BotFrameworkActivity,
): boolean {
  const configured = account.agentId.trim();
  const assertions = [activity.recipient?.agenticUserId, activity.recipient?.id]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const normalizedConfigured = configured.toLowerCase();
  return (
    !configured ||
    assertions.length === 0 ||
    assertions.some((assertion) => assertion.toLowerCase() === normalizedConfigured)
  );
}

function buildInboundMessage(
  account: ResolvedM365MailAccount,
  activity: BotFrameworkActivity,
  emailEntity: EmailNotificationEntity | undefined,
  commandAuthorized: boolean,
): M365MailInboundMessage | null {
  const conversationId = resolveConversationId(activity, emailEntity);
  if (!conversationId) {
    return null;
  }
  const fromAddress = activity.from?.id?.trim() ?? "";
  const body = sanitizeInput(extractBodyText(activity, emailEntity));
  return {
    body,
    conversationId,
    // Only the emailNotification entity carries a Graph message id (valid for
    // `/users/{agentId}/messages/{id}/reply`). `activity.id` is the Bot Framework
    // activity instance id — a different namespace that Graph 404s — so it must
    // NOT be used here, or the threaded-reply branch would always be taken and
    // the sendMail-to-sender fallback (when no Graph id exists) would never
    // engage.
    messageId: emailEntity?.id?.trim() || undefined,
    fromAddress,
    fromId: fromAddress || undefined,
    // The activity may carry both object-id and UPN forms. Preserve the trusted
    // configured form when either assertion matches; otherwise pass the
    // preferred assertion downstream so owner preparation rejects the mismatch.
    agentId: resolveInboundAgentIdentityAssertion(account, activity),
    senderName: activity.from?.name?.trim() || fromAddress || conversationId,
    subject: activity.conversation?.topic?.trim() || undefined,
    accountId: account.accountId,
    commandAuthorized,
  };
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;
  const rateLimiter = getRateLimiter(account);

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const requestLifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      inFlightLimiter: webhookInFlightLimiter,
      inFlightKey: account.accountId,
    });
    if (!requestLifecycle.ok) {
      return;
    }

    let message: M365MailInboundMessage | null = null;
    try {
      const bodyResult = await readBody(req);
      if (!bodyResult.ok) {
        respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
        return;
      }

      const parsed = parseActivity(bodyResult.body);
      if (!parsed.ok) {
        respondJson(res, 400, { error: "Invalid email activity" });
        return;
      }

      const activity = parsed.activity;
      const emailEntity = findEmailEntity(activity);
      const conversationId = resolveConversationId(activity, emailEntity);
      if (!conversationId) {
        respondJson(res, 400, { error: "Missing conversationId" });
        return;
      }
      const messageId = emailEntity?.id?.trim();
      if (!messageId) {
        respondJson(res, 400, { error: "Missing email message id" });
        return;
      }

      const senderKey = normalizeLowercaseStringOrEmpty(activity.from?.id) || conversationId;

      if (!matchesInboundAgentIdentity(account, activity)) {
        log?.warn(`Microsoft 365 email recipient identity rejected (${conversationId})`);
        respondJson(res, 403, { error: "Recipient identity not authorized" });
        return;
      }

      // Cross-tenant sender gate (fail-closed). The runtime only authorizes the
      // recipient owner's opt-in; the sender boundary lives here. By default
      // (`allowCrossTenant=false`) the sender must positively be in the agent
      // owner's tenant (carried on the activity recipient / conversation): a
      // sender whose tenant is absent — the common AOS email shape, which
      // carries no authenticated `from.tenantId` — or different is rejected, so
      // an opted-in agent is never driven by an unauthenticated / external
      // sender. `allowCrossTenant` opts into accepting them. See
      // `authorizeSenderTenant` for the full posture + the deferred
      // owner-only/verified-identity follow-up.
      //
      // Field choice is load-bearing: `from.tenantId` is the only field that
      // carries the SENDER's home tenant. The notification-scope fields
      // (`recipient.tenantId`, `conversation.tenantId`, `channelData.tenant.id`)
      // all carry the AGENT/notification tenant — AOS delivers the email
      // notification into the owner's own mailbox tenant — so they are the
      // `ownerTenant` side of the compare, never the sender side. Deriving
      // `senderTenant` from any of them would make the compare `owner === owner`
      // (always true) and silently defeat this gate. The runtime forwards the
      // raw AOS activity verbatim (only `serviceUrl` is patched), so a real
      // same-tenant email arrives with `from.tenantId` populated and is
      // accepted; only genuinely tenant-less/external senders fail closed.
      //
      // The owner-tenant chain must include EVERY field AOS/runtime may stamp
      // the notification tenant on (`recipient.tenantId` → `conversation.tenantId`
      // → `channelData.tenant.id`, mirroring the runtime's own routing
      // resolution). Omitting one lets a payload that carries the owner tenant
      // ONLY on the omitted field resolve `ownerTenant=""`, which makes
      // `authorizeSenderTenant` fall through to the DM policy — and a default
      // `dmPolicy="open"` would then accept a tenant-less / cross-tenant sender
      // despite `allowCrossTenant=false`. Keeping the chain complete keeps the
      // strict same-tenant compare in force.
      const senderTenant = normalizeLowercaseStringOrEmpty(activity.from?.tenantId);
      const ownerTenant =
        normalizeLowercaseStringOrEmpty(activity.recipient?.tenantId) ||
        normalizeLowercaseStringOrEmpty(activity.conversation?.tenantId) ||
        normalizeLowercaseStringOrEmpty(activity.channelData?.tenant?.id);
      if (!authorizeSenderTenant(account.allowCrossTenant, senderTenant, ownerTenant)) {
        log?.warn(
          `Cross-tenant or unauthenticated email sender rejected (conversation ${conversationId})`,
        );
        respondJson(res, 403, { error: "Cross-tenant sender not authorized" });
        return;
      }

      const auth = authorizeSenderForDm(senderKey, account.dmPolicy, account.allowedSenders);
      if (!auth.allowed) {
        if (auth.reason === "disabled") {
          respondJson(res, 403, { error: "Email DMs are disabled" });
          return;
        }
        if (auth.reason === "allowlist-empty") {
          log?.warn(
            "Microsoft 365 email allowlist is empty while dmPolicy=allowlist; rejecting message",
          );
          respondJson(res, 403, {
            error: "Allowlist is empty. Configure allowedSenders or use dmPolicy=open.",
          });
          return;
        }
        log?.warn(`Unauthorized sender (${maskSender(senderKey)}, conversation ${conversationId})`);
        respondJson(res, 403, { error: "Sender not authorized" });
        return;
      }

      const deliveredMessages = getDeliveredMessages(account.accountId);
      while (true) {
        if (deliveredMessages.peek(messageId)) {
          respondAccepted(res);
          return;
        }
        const reservation = reservePendingDelivery(account.accountId, messageId);
        if (!reservation.leader) {
          if (await reservation.completion) {
            respondAccepted(res);
            return;
          }
          continue;
        }

        let committed = false;
        try {
          if (await deliveredMessages.lookup(messageId)) {
            committed = true;
            respondAccepted(res);
            return;
          }
          if (!rateLimiter.check(senderKey)) {
            log?.warn(
              `Rate limit exceeded for sender (${maskSender(senderKey)}, conversation ${conversationId})`,
            );
            respondJson(res, 429, { error: "Rate limit exceeded" });
            return;
          }
          const deliveredAt = Date.now();
          await deliveredMessages.register(messageId, { deliveredAt }, { at: deliveredAt });
          committed = true;
          break;
        } finally {
          reservation.complete(committed);
        }
      }

      message = buildInboundMessage(account, activity, emailEntity, auth.allowed);
      if (!message || !message.body.trim()) {
        // Nothing actionable (e.g. empty body) — ACK without dispatching.
        respondAccepted(res);
        return;
      }

      // ACK immediately so the runtime delivery isn't held open while the agent runs.
      respondAccepted(res);
    } finally {
      requestLifecycle.release();
    }

    if (!message) {
      return;
    }

    const actionable = message;
    // Log bounded metadata only — never the email body or sender PII. The body
    // can contain personal / sensitive content, so we record the conversation
    // id and body length for correlation and nothing else.
    log?.info(
      `Email received (conversation ${actionable.conversationId}, ${actionable.body.length} chars)`,
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const deliverPromise = deliver(actionable);
      const timeoutPromise = new Promise<null>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Agent response timeout (180s)")),
          AGENT_RESPONSE_TIMEOUT_MS,
        );
      });
      await Promise.race([deliverPromise, timeoutPromise]);
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      log?.error(
        `Failed to process email for conversation ${actionable.conversationId}: ${errMsg}`,
      );
    } finally {
      // Clear the timeout when deliver() wins the race so the 180s timer does
      // not keep the event loop alive per delivered email.
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  };
}
