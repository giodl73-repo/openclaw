import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it, vi } from "vitest";

const sendNewMail = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./graph.js", () => ({
  sendNewMail,
}));

import { m365MailPlugin } from "./channel.js";

describe("m365mail channel pairing", () => {
  it("uses the selected account for pairing approval notifications", async () => {
    const cfg = {
      channels: {
        m365mail: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              graphBaseUrl: "https://graph.microsoft.us/v1.0",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    await m365MailPlugin.pairing.notifyApproval({
      cfg,
      id: "sender@contoso.com",
      accountId: "work",
    });

    expect(sendNewMail).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: {
          account: expect.objectContaining({
            accountId: "work",
            graphBaseUrl: "https://graph.microsoft.us/v1.0",
          }),
        },
        toAddress: "sender@contoso.com",
      }),
    );
  });

  it("clears cross-tenant policy when deleting the default account", () => {
    const updated = m365MailPlugin.config.deleteAccount?.({
      cfg: {
        channels: {
          m365mail: {
            enabled: true,
            allowCrossTenant: true,
            accounts: { work: { enabled: true } },
          },
        },
      } as unknown as OpenClawConfig,
      accountId: "default",
    }) as OpenClawConfig;

    expect(updated.channels?.m365mail?.allowCrossTenant).toBeUndefined();
    expect(updated.channels?.m365mail?.accounts).toEqual({ work: { enabled: true } });
  });
});
