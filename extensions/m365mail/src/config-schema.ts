import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const M365MailAccountConfigShape = {
  enabled: z.boolean().optional(),
  graphBaseUrl: z.string().optional(),
  webhookPath: z.string().optional(),
  dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  allowedSenders: z.union([z.string(), z.array(z.string())]).optional(),
  allowCrossTenant: z.boolean().optional(),
  rateLimitPerMinute: z.number().int().positive().optional(),
  botName: z.string().optional(),
};

const M365MailAccountConfigSchema = z.object(M365MailAccountConfigShape);

export const M365MailChannelConfigSchema = buildChannelConfigSchema(
  z.object({
    ...M365MailAccountConfigShape,
    accounts: z.record(z.string(), M365MailAccountConfigSchema).optional(),
  }),
);
