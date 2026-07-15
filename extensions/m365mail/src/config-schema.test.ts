import { describe, expect, it } from "vitest";
import { M365MailChannelConfigSchema } from "./config-schema.js";

const runtime = M365MailChannelConfigSchema.runtime;
if (!runtime) {
  throw new Error("expected m365mail runtime config validation");
}

describe("M365MailChannelConfigSchema", () => {
  it("accepts the complete root and named-account config surface", () => {
    const result = runtime.safeParse({
      enabled: true,
      graphBaseUrl: "https://graph.microsoft.com/v1.0",
      webhookPath: "/webhook/m365mail",
      dmPolicy: "allowlist",
      allowedSenders: ["ada@contoso.com"],
      allowCrossTenant: false,
      rateLimitPerMinute: 30,
      botName: "Mail Agent",
      accounts: {
        work: {
          enabled: true,
          webhookPath: "/webhook/m365mail-work",
          allowedSenders: "grace@contoso.com",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid sender allowlists at the root and account levels", () => {
    const rootResult = runtime.safeParse({
      allowedSenders: 42,
    });
    const accountResult = runtime.safeParse({
      accounts: { work: { allowedSenders: 42 } },
    });

    expect(rootResult.success).toBe(false);
    expect(accountResult.success).toBe(false);
  });

  it("rejects invalid policies and rate limits", () => {
    expect(runtime.safeParse({ dmPolicy: "contacts" }).success).toBe(false);
    expect(runtime.safeParse({ rateLimitPerMinute: 1.5 }).success).toBe(false);
    expect(
      runtime.safeParse({
        accounts: { work: { rateLimitPerMinute: 0 } },
      }).success,
    ).toBe(false);
  });
});
