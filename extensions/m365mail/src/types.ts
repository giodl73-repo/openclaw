/**
 * Type definitions for the Microsoft 365 email channel plugin.
 *
 * Unlike webhook channels that own their own credentials, this channel runs in
 * A host-managed OpenClaw container in *brokered* mode: inbound email is
 * delivered by the external host runtime to a loopback webhook, and outbound replies
 * are sent via Microsoft Graph with NO Authorization header — the runtime egress
 * proxy injects the agent's own bearer token on the wire. No secret ever lives
 * in the container.
 */

type M365MailConfigFields = {
  enabled?: boolean;
  /** Microsoft Graph base URL (default https://graph.microsoft.com/v1.0). */
  graphBaseUrl?: string;
  /** Loopback path the external host runtime posts inbound email activities to. */
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  /** Allowed sender email addresses or UPNs for dmPolicy=allowlist. */
  allowedSenders?: string | string[];
  /**
   * When false (default) inbound email is restricted to senders in the agent
   * owner's tenant; cross-tenant AND tenant-less (unauthenticated) senders are
   * rejected (fail-closed). Set true to accept external senders. Mirrors the
   * `M365MAIL_ALLOW_CROSS_TENANT` env contract.
   */
  allowCrossTenant?: boolean;
  rateLimitPerMinute?: number;
  botName?: string;
};

/** Raw channel config from openclaw.json channels.m365mail */
export interface M365MailChannelConfig extends M365MailConfigFields {
  accounts?: Record<string, M365MailAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface M365MailAccountRaw extends M365MailConfigFields {}

/** Fully resolved account config with defaults applied */
export interface ResolvedM365MailAccount {
  accountId: string;
  enabled: boolean;
  /** True when running in brokered mode (no in-container token). */
  brokered: boolean;
  graphBaseUrl: string;
  /**
   * The agent's own mailbox identifier (Entra object id or UPN) used to
   * self-address outbound Graph sends as `/users/{agentId}/…`. Seeded from the
   * `OPENCLAW_M365MAIL_AGENT_ID` env the external host adapter projects from
   * the provisioned agent identity. Empty until provisioning completes. Inbound
   * activity identity may attest to this value but may never override it.
   */
  agentId: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedSenders: string[];
  /** When false, reject senders outside the agent owner's tenant. */
  allowCrossTenant: boolean;
  rateLimitPerMinute: number;
  botName: string;
}

// ─── Inbound wire contract: Bot Framework Activity ──────────────────────────
//
// Inbound email arrives on the shared ACF / Agent 365 `bot-activities` callback
// as a Bot Framework–derived "Activity". The external host runtime forwards that
// activity VERBATIM to this plugin's loopback webhook — the Activity IS the
// contract (mirrors the msteams native-delivery path). For email,
// `type == "message"` and `name == "emailNotification"`, and the body lives in
// an `emailNotification` entity in `entities[]`. See the runtime's
// `aos_notifications::types::Activity` (the canonical Rust model) and the
// EMAIL_PAYLOAD fixtures.

/** Sender / recipient identity on a Bot Framework activity (`ChannelAccount`). */
export interface BotFrameworkChannelAccount {
  /** Primary identifier — the SMTP address / UPN for the user. */
  id?: string;
  /**
   * Entra object id of an agentic user (`role="agenticUser"`). AOS stamps this
   * on the notification `recipient` (the agent). It can attest to the trusted
   * configured mailbox identity, but it must never select or override the
   * mailbox used for an outbound Graph request.
   */
  agenticUserId?: string;
  /** Display name. */
  name?: string;
  /** Role discriminator: `"user"` or `"agenticUser"`. */
  role?: string;
  /** AAD tenant the identity belongs to (used for cross-tenant sender gating). */
  tenantId?: string;
}

/** Conversation context carried on the activity. */
export interface BotFrameworkConversation {
  /** Conversation/thread id — the email session peer. */
  id?: string;
  conversationType?: string;
  tenantId?: string;
  /** Document/thread topic, when present. */
  topic?: string;
}

/**
 * The `emailNotification` entity embedded in `entities[]`. Carries the email
 * id, its conversation id, and the raw HTML body.
 */
export interface EmailNotificationEntity {
  type: "emailNotification";
  /** Graph message id of the inbound mail — used for threaded replies. */
  id?: string;
  /** Conversation id the email belongs to. */
  conversationId?: string;
  /** Raw HTML body of the email. */
  htmlBody?: string;
}

/** A single, possibly-unknown entity from the activity `entities[]` array. */
export interface BotFrameworkEntity {
  type?: string;
  [key: string]: unknown;
}

/**
 * Channel-specific data bag on the activity. AOS stamps the tenant the
 * notification was delivered into (the agent/owner mailbox tenant) at
 * `channelData.tenant.id`; the runtime's own routing treats this as an
 * owner-tenant source, so the sender gate includes it in the owner-tenant
 * resolution.
 */
export interface BotFrameworkChannelData {
  /** Tenant the notification was delivered into (the agent/owner tenant). */
  tenant?: { id?: string };
  [key: string]: unknown;
}

/**
 * The top-level Bot Framework Activity the runtime forwards to the webhook.
 * Only the fields this plugin reads for email are modeled; the wire payload may
 * carry more (forward-compatible).
 */
export interface BotFrameworkActivity {
  /** Unique id for this activity instance. */
  id?: string;
  timestamp?: string;
  channelId?: string;
  /** Connector service URL for sending replies (opaque here; we use Graph). */
  serviceUrl?: string;
  /** Identity of the agent receiving the notification. */
  recipient?: BotFrameworkChannelAccount;
  /** Conversation context (id is the email thread / session peer). */
  conversation?: BotFrameworkConversation;
  /** Identity of the user who sent the email. */
  from?: BotFrameworkChannelAccount;
  /** Activity type — `"message"` for email notifications. */
  type?: string;
  /** Notification discriminator — `"emailNotification"` for email. */
  name?: string;
  locale?: string;
  /** Plain-text content, when the platform flattens it. */
  text?: string;
  /** Typed entity bag — source of truth for the email body + ids. */
  entities?: BotFrameworkEntity[];
  /**
   * Channel-specific data; `tenant.id` carries the notification/owner tenant
   * and participates in the sender gate's owner-tenant resolution.
   */
  channelData?: BotFrameworkChannelData;
}
