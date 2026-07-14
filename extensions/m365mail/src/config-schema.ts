import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

export const M365MailChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      graphBaseUrl: z.string().optional(),
      webhookPath: z.string().optional(),
      allowCrossTenant: z.boolean().optional(),
    })
    .passthrough(),
);
