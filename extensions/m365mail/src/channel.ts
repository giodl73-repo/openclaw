/**
 * Microsoft 365 email channel plugin for OpenClaw.
 *
 * Mirrors the native msteams provider but keys sessions on the email
 * conversationId. Runs brokered in a host-managed per-user container: inbound email
 * arrives on a loopback webhook from the runtime; outbound replies go via
 * Microsoft Graph under the agent's own identity (the runtime injects the token).
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  composeWarningCollectors,
  createConditionalWarningCollector,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { m365MailApprovalAuth } from "./approval-auth.js";
import { M365MailChannelConfigSchema } from "./config-schema.js";
import {
  collectM365MailGatewayRoutingWarnings,
  registerM365MailWebhookRoute,
  validateM365MailGatewayAccountStartup,
} from "./gateway-runtime.js";
import { sendNewMail } from "./graph.js";
import { collectM365MailSecurityAuditFindings } from "./security-audit.js";
import { m365MailSetupAdapter, m365MailSetupWizard } from "./setup-surface.js";
import type { ResolvedM365MailAccount } from "./types.js";

const CHANNEL_ID = "m365mail";

const resolveM365MailDmPolicy = createScopedDmSecurityResolver<ResolvedM365MailAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowedSenders,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "open",
  approveHint: "openclaw pairing approve m365mail <code>",
  normalizeEntry: (raw) => normalizeLowercaseStringOrEmpty(raw),
});

type M365MailChannelGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};
type M365MailChannelOutboundContext = {
  cfg: OpenClawConfig;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
};
type M365MailChannelSendTextContext = M365MailChannelOutboundContext & { text: string };
type M365MailSecurityWarningContext = {
  cfg: OpenClawConfig;
  account: ResolvedM365MailAccount;
};

const m365MailConfigAdapter = createHybridChannelConfigAdapter<ResolvedM365MailAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: [
    "auth",
    "graphBaseUrl",
    "webhookPath",
    "dmPolicy",
    "allowedSenders",
    "allowCrossTenant",
    "rateLimitPerMinute",
    "botName",
  ],
  resolveAllowFrom: (account) => account.allowedSenders,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => normalizeLowercaseStringOrEmpty(String(entry))).filter(Boolean),
});

const collectM365MailSecurityWarnings = createConditionalWarningCollector<ResolvedM365MailAccount>(
  (account) =>
    account.dmPolicy === "open" &&
    '- Microsoft 365 Email: dmPolicy="open" allows any sender to message the agent. Consider "allowlist" for production use.',
  (account) =>
    account.dmPolicy === "allowlist" &&
    account.allowedSenders.length === 0 &&
    '- Microsoft 365 Email: dmPolicy="allowlist" with empty allowedSenders blocks all senders. Add addresses or set dmPolicy="open".',
);

type M365MailOutboundResult = {
  channel: typeof CHANNEL_ID;
  messageId: string;
  chatId: string;
};

type M365MailPlugin = Omit<
  ChannelPlugin<ResolvedM365MailAccount>,
  "pairing" | "security" | "messaging" | "directory" | "outbound" | "gateway" | "agentPrompt"
> & {
  pairing: {
    idLabel: string;
    normalizeAllowEntry?: (entry: string) => string;
    notifyApproval: (params: {
      cfg: OpenClawConfig;
      id: string;
      accountId?: string;
    }) => Promise<void>;
  };
  security: {
    resolveDmPolicy: (params: { cfg: OpenClawConfig; account: ResolvedM365MailAccount }) => {
      policy: string | null | undefined;
      allowFrom?: Array<string | number>;
      normalizeEntry?: (raw: string) => string;
    } | null;
    collectWarnings: (params: {
      cfg: OpenClawConfig;
      account: ResolvedM365MailAccount;
    }) => string[];
  };
  messaging: {
    normalizeTarget: (target: string) => string | undefined;
    targetResolver: {
      looksLikeId: (id: string) => boolean;
      hint: string;
    };
  };
  directory: {
    self?: NonNullable<ChannelPlugin<ResolvedM365MailAccount>["directory"]>["self"];
    listPeers?: NonNullable<ChannelPlugin<ResolvedM365MailAccount>["directory"]>["listPeers"];
    listGroups?: NonNullable<ChannelPlugin<ResolvedM365MailAccount>["directory"]>["listGroups"];
  };
  outbound: {
    deliveryMode: "gateway";
    textChunkLimit: number;
    sendText: (ctx: M365MailChannelSendTextContext) => Promise<M365MailOutboundResult>;
    sendMedia: (ctx: M365MailChannelOutboundContext) => Promise<M365MailOutboundResult>;
  };
  gateway: {
    startAccount: (ctx: M365MailChannelGatewayContext) => Promise<unknown>;
    stopAccount: (ctx: M365MailChannelGatewayContext) => Promise<void>;
  };
  agentPrompt: {
    messageToolHints: () => string[];
  };
};

const collectM365MailRoutingWarnings = projectAccountConfigWarningCollector<
  ResolvedM365MailAccount,
  OpenClawConfig,
  M365MailSecurityWarningContext
>(
  (cfg) => cfg,
  ({ account, cfg }) => collectM365MailGatewayRoutingWarnings({ account, cfg }),
);

function resolveOutboundAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedM365MailAccount {
  return resolveAccount(cfg ?? {}, accountId);
}

function normalizeEmailTarget(target: string): string | undefined {
  const trimmed = target
    .trim()
    .replace(/^m365mail:/i, "")
    .trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createM365MailPlugin(): M365MailPlugin {
  return createChatChannelPlugin({
    base: {
      id: CHANNEL_ID,
      meta: {
        id: CHANNEL_ID,
        label: "Microsoft 365 Email",
        selectionLabel: "Microsoft 365 Email (Graph)",
        detailLabel: "Microsoft 365 Email (Graph)",
        docsPath: "/channels/m365mail",
        blurb: "Let your agent receive and reply to Microsoft 365 email under its own identity",
        order: 95,
      },
      capabilities: {
        chatTypes: ["direct" as const],
        media: false,
        threads: false,
        reactions: false,
        edit: false,
        unsend: false,
        reply: false,
        effects: false,
        blockStreaming: false,
      },
      reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
      configSchema: M365MailChannelConfigSchema,
      setup: m365MailSetupAdapter,
      setupWizard: m365MailSetupWizard,
      config: {
        ...m365MailConfigAdapter,
      },
      approvalCapability: m365MailApprovalAuth,
      messaging: {
        normalizeTarget: (target: string) => normalizeEmailTarget(target),
        targetResolver: {
          looksLikeId: (id: string) => {
            const trimmed = id?.trim();
            if (!trimmed) {
              return false;
            }
            return /@/.test(trimmed) || /^m365mail:/i.test(trimmed);
          },
          hint: "<email-address>",
        },
      },
      directory: createEmptyChannelDirectoryAdapter(),
      gateway: {
        startAccount: async (ctx: M365MailChannelGatewayContext) => {
          const { cfg, accountId, log, abortSignal } = ctx;
          const account = resolveAccount(cfg, accountId);
          if (!validateM365MailGatewayAccountStartup({ cfg, account, accountId, log }).ok) {
            return waitUntilAbort(abortSignal);
          }

          log?.info?.(
            `Starting Microsoft 365 Email channel (account: ${accountId}, path: ${account.webhookPath})`,
          );
          const unregister = registerM365MailWebhookRoute({ account, accountId, log });

          log?.info?.(`Registered HTTP route: ${account.webhookPath} for Microsoft 365 Email`);

          return waitUntilAbort(abortSignal, () => {
            log?.info?.(`Stopping Microsoft 365 Email channel (account: ${accountId})`);
            unregister();
          });
        },

        stopAccount: async (ctx: M365MailChannelGatewayContext) => {
          ctx.log?.info?.(`Microsoft 365 Email account ${ctx.accountId} stopped`);
        },
      },
      agentPrompt: {
        messageToolHints: () => [
          "",
          "### Microsoft 365 Email Formatting",
          "You are replying over email. Replies are sent as plain text.",
          "",
          "**Tone & framing**:",
          "- This is asynchronous email correspondence with an ongoing thread.",
          "- Never say you have 'just come online', 'just started up', are 'now available', or otherwise reference session startup, runtime state, or being a newly-initialized agent. The recipient does not see sessions — only email.",
          "- Reply as an ongoing correspondent answering the message in front of you, not as an assistant opening a new session.",
          "- Do not introduce yourself unprompted; only state who you are if the sender asks.",
          "",
          "**Email is not chat**:",
          "- Email is asynchronous and high-latency: round-trips can take hours or days. Be complete and self-contained in a single reply rather than asking a series of small follow-up questions; if you must ask, gather all open questions into one message.",
          "- Messages are durable and forwardable: the recipient may read it later, out of context, or forward it to others. Include enough context to stand on its own; avoid relying on transient or chat-only state.",
          "- Favor a slightly more formal, considered register than instant chat — full sentences, clear structure — without being stiff.",
          "- Do not expect or request an immediate response, and do not pepper the thread with rapid-fire messages.",
          "",
          "**Best practices**:",
          "- Open with a brief, situation-appropriate greeting and close with a short sign-off.",
          "- Keep paragraphs short; use blank lines to separate sections",
          "- Use numbered or bulleted lists for steps or options",
          "- Do not assume rich formatting (no markdown, bold, or HTML)",
          "- Each reply stays within the same mail thread (conversation)",
        ],
      },
    },
    pairing: {
      text: {
        idLabel: "m365MailSender",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: (entry: string) => normalizeLowercaseStringOrEmpty(entry),
        notify: async ({ cfg, id, message, accountId }) => {
          const account = resolveAccount(cfg, accountId);
          const target = normalizeEmailTarget(id);
          if (!target || !/@/.test(target)) {
            return;
          }
          await sendNewMail({
            ctx: { account },
            text: message,
            toAddress: target,
            subject: "OpenClaw access approved",
          });
        },
      },
    },
    security: {
      resolveDmPolicy: resolveM365MailDmPolicy,
      collectWarnings: composeWarningCollectors(
        projectAccountWarningCollector<ResolvedM365MailAccount, M365MailSecurityWarningContext>(
          collectM365MailSecurityWarnings,
        ),
        collectM365MailRoutingWarnings,
      ),
      collectAuditFindings: collectM365MailSecurityAuditFindings,
    },
    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 100_000,

      sendText: async ({ to, text, accountId, cfg }: M365MailChannelSendTextContext) => {
        const account = resolveOutboundAccount(cfg ?? {}, accountId);
        const target = normalizeEmailTarget(to);
        if (!target || !/@/.test(target)) {
          throw new Error("Microsoft 365 Email target must be an email address");
        }
        await sendNewMail({
          ctx: { account },
          text,
          toAddress: target,
          subject: "Message from OpenClaw",
        });
        return attachChannelToResult(CHANNEL_ID, {
          messageId: `m365mail-${Date.now()}`,
          chatId: target,
        });
      },

      sendMedia: async (_ctx: M365MailChannelOutboundContext) => {
        throw new Error("Microsoft 365 Email channel does not support media attachments");
      },
    },
  }) as unknown as M365MailPlugin;
}

export const m365MailPlugin = createM365MailPlugin();
