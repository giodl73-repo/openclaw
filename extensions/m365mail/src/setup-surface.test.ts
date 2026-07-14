import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import { m365MailSetupAdapter, m365MailSetupWizard } from "./setup-surface.js";

const resolveAccountId = m365MailSetupAdapter.resolveAccountId!;
const validateInput = m365MailSetupAdapter.validateInput!;
const applyAccountConfig = m365MailSetupAdapter.applyAccountConfig!;
const disableChannel = m365MailSetupWizard.disable!;

const defaultAccountId = resolveAccountId({
  accountId: undefined,
} as never);

function m365mailChannel(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg.channels?.m365mail as Record<string, unknown> | undefined) ?? {};
}

describe("m365mail setup surface adapter", () => {
  it("resolves a stable default account id when none is provided", () => {
    expect(typeof defaultAccountId).toBe("string");
    expect(defaultAccountId.length).toBeGreaterThan(0);
  });

  it("validateInput accepts any input (brokered channel needs no credential)", () => {
    expect(validateInput({} as never)).toBeNull();
  });

  it("applyAccountConfig enables the m365mail channel on the default account", () => {
    const next = applyAccountConfig({
      cfg: {} as OpenClawConfig,
      accountId: defaultAccountId,
    } as never);

    expect(m365mailChannel(next).enabled).toBe(true);
  });

  it("applyAccountConfig preserves sibling channels and existing m365mail fields", () => {
    const cfg = {
      channels: {
        msteams: { enabled: true },
        m365mail: { dmPolicy: "allowlist", allowedSenders: ["ada@contoso.com"] },
      },
    } as unknown as OpenClawConfig;

    const next = applyAccountConfig({
      cfg,
      accountId: defaultAccountId,
    } as never);

    // Operator dmPolicy/allowedSenders are field-merged, not clobbered.
    expect(m365mailChannel(next).enabled).toBe(true);
    expect(m365mailChannel(next).dmPolicy).toBe("allowlist");
    expect(m365mailChannel(next).allowedSenders).toEqual(["ada@contoso.com"]);
    // Sibling channel is untouched.
    expect((next.channels?.msteams as Record<string, unknown>)?.enabled).toBe(true);
  });
});

describe("m365mail setup wizard", () => {
  it("targets the m365mail channel", () => {
    expect(m365MailSetupWizard.channel).toBe("m365mail");
  });

  it("disable() turns the channel off without dropping the channel block", () => {
    const enabled = applyAccountConfig({
      cfg: {} as OpenClawConfig,
      accountId: defaultAccountId,
    } as never);

    const disabled = disableChannel(enabled);

    expect(m365mailChannel(disabled).enabled).toBe(false);
  });
});
