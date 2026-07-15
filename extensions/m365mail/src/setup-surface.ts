import {
  createAllowFromSection,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  setSetupChannelEnabled,
  splitSetupEntries,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { listAccountIds, resolveAccount } from "./accounts.js";
import type { M365MailAccountRaw, M365MailChannelConfig } from "./types.js";

const channel = "m365mail" as const;

const M365MAIL_SETUP_HELP_LINES = [
  "Microsoft 365 email runs brokered inside a host-managed container:",
  "1) The external host provisions the agent identity and projects M365MAIL_* env vars",
  "2) Inbound email is delivered to the agent automatically",
  "3) Replies are sent via Microsoft Graph under the agent's own identity",
  "No token is configured here — just enable the channel and (optionally) gate senders.",
  `Docs: ${formatDocsLink("/channels/m365mail", "channels/m365mail")}`,
];

const M365MAIL_ALLOW_FROM_HELP_LINES = [
  "Allowlist Microsoft 365 email senders by address or UPN.",
  "Examples:",
  "- ada@contoso.com",
  "- m365mail:ada@contoso.com",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/m365mail", "channels/m365mail")}`,
];

function getChannelConfig(cfg: OpenClawConfig): M365MailChannelConfig {
  return (cfg.channels?.[channel] as M365MailChannelConfig | undefined) ?? {};
}

function getRawAccountConfig(cfg: OpenClawConfig, accountId: string): M365MailAccountRaw {
  const channelConfig = getChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return channelConfig;
  }
  return channelConfig.accounts?.[accountId] ?? {};
}

function patchM365MailAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const channelConfig = getChannelConfig(params.cfg);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    const nextChannelConfig = { ...channelConfig } as Record<string, unknown>;
    for (const field of params.clearFields ?? []) {
      delete nextChannelConfig[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [channel]: {
          ...nextChannelConfig,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccounts = { ...channelConfig.accounts } as Record<string, Record<string, unknown>>;
  const nextAccountConfig = { ...nextAccounts[params.accountId] };
  for (const field of params.clearFields ?? []) {
    delete nextAccountConfig[field];
  }
  nextAccounts[params.accountId] = {
    ...nextAccountConfig,
    ...(params.enabled ? { enabled: true } : {}),
    ...params.patch,
  };

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [channel]: {
        ...channelConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: nextAccounts,
      },
    },
  };
}

function isM365MailConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  // Brokered channel: enabling it is sufficient; the runtime brokers identity.
  return listAccountIds(cfg).includes(accountId) && resolveAccount(cfg, accountId).enabled;
}

function parseM365MailSenderId(value: string): string | null {
  const cleaned = value
    .replace(/^m365mail:/i, "")
    .trim()
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeAllowedSender(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`.trim().toLowerCase();
  }
  return "";
}

function resolveExistingAllowedSenders(cfg: OpenClawConfig, accountId: string): string[] {
  const raw = getRawAccountConfig(cfg, accountId).allowedSenders;
  if (Array.isArray(raw)) {
    return raw.map(normalizeAllowedSender).filter(Boolean);
  }
  return normalizeAllowedSender(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const m365MailSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID,
  validateInput: () => null,
  applyAccountConfig: ({ cfg, accountId }) =>
    patchM365MailAccountConfig({
      cfg,
      accountId,
      enabled: true,
      patch: {},
    }),
};

export const m365MailSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Microsoft 365 Email",
    configuredLabel: "enabled",
    unconfiguredLabel: "disabled",
    configuredHint: "enabled",
    unconfiguredHint: "disabled",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      accountId
        ? isM365MailConfigured(cfg, accountId)
        : listAccountIds(cfg).some((candidateAccountId) =>
            isM365MailConfigured(cfg, candidateAccountId),
          ),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listAccountIds(cfg).length || 0}`],
  }),
  introNote: {
    title: "Microsoft 365 email (brokered)",
    lines: M365MAIL_SETUP_HELP_LINES,
  },
  credentials: [],
  allowFrom: createAllowFromSection({
    helpTitle: "Microsoft 365 email allowlist",
    helpLines: M365MAIL_ALLOW_FROM_HELP_LINES,
    message: "Allowed Microsoft 365 email senders",
    placeholder: "ada@contoso.com, grace@contoso.com",
    invalidWithoutCredentialNote: "Senders must be email addresses or UPNs.",
    parseInputs: splitSetupEntries,
    parseId: parseM365MailSenderId,
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchM365MailAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: {
          dmPolicy: "allowlist",
          allowedSenders: mergeAllowFromEntries(
            resolveExistingAllowedSenders(cfg, accountId),
            allowFrom,
          ),
        },
      }),
  }),
  completionNote: {
    title: "Microsoft 365 email access control",
    lines: [
      'Senders are open by default. Set allowed senders, or keep `channels.m365mail.dmPolicy="open"` to accept any sender.',
      'With `dmPolicy="allowlist"`, an empty allowedSenders list blocks the route from starting.',
      `Docs: ${formatDocsLink("/channels/m365mail", "channels/m365mail")}`,
    ],
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
